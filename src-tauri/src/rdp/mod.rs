//! Embedded RDP client built on IronRDP.
//!
//! Mirrors the shape of [`crate::ssh::SessionManager`] / [`crate::sftp::SftpManager`]:
//! a [`RdpManager`] owns one task per live session. Each task runs the IronRDP
//! active stage, decodes the remote framebuffer and streams **dirty rectangles**
//! (not whole frames — WebView2 is slow on large binary payloads) to the
//! frontend over a `tauri::ipc::Channel`. Keyboard/mouse/resize/disconnect flow
//! back in through an mpsc channel driven by the `rdp_*` Tauri commands.
//!
//! Security note: RDP has its own TLS + CredSSP/NLA stack, so it does **not**
//! go through `SshClientHandler`/TOFU (that is SSH-specific). Credentials are
//! decrypted via `VaultManager` by the caller and only ever live in memory.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use ironrdp::connector::{ClientConnector, Config, Credentials, ServerName};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::PerformanceFlags;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::reqwest::ReqwestNetworkClient;
use ironrdp_tokio::{connect_begin, connect_finalize, mark_as_upgraded, TokioFramed};

/// Control messages sent from the Tauri commands into a running session task.
enum RdpCommand {
    Input(Vec<Operation>),
    Disconnect,
}

struct RdpSessionHandle {
    tx: mpsc::UnboundedSender<RdpCommand>,
}

#[derive(Default)]
pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, RdpSessionHandle>>>,
}

/// Returned to the frontend once the handshake succeeds, so the canvas can be
/// sized to the desktop the server actually granted (which may differ from the
/// requested geometry).
#[derive(Serialize)]
pub struct RdpConnectInfo {
    pub width: u16,
    pub height: u16,
}

/// A single input event coming from the browser canvas. Mirrors the DOM event
/// shapes so the mapping on the frontend stays trivial.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RdpInputEvent {
    #[serde(rename_all = "camelCase")]
    MouseMove { x: u16, y: u16 },
    #[serde(rename_all = "camelCase")]
    MouseButton { button: u8, down: bool, x: u16, y: u16 },
    #[serde(rename_all = "camelCase")]
    Wheel { vertical: bool, units: i16 },
    #[serde(rename_all = "camelCase")]
    Key { scancode: u16, down: bool },
    #[serde(rename_all = "camelCase")]
    Unicode { ch: char, down: bool },
}

impl RdpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Establish a connection and spawn the active-stage task. Returns the
    /// negotiated desktop size on success.
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        app: AppHandle,
        session_id: String,
        address: String,
        port: u16,
        username: String,
        password: String,
        domain: Option<String>,
        width: u16,
        height: u16,
        on_frame: Channel<InvokeResponseBody>,
    ) -> Result<RdpConnectInfo, String> {
        let server_name = address.clone();

        // ── TCP ──────────────────────────────────────────────────────────────
        let tcp = tokio::net::TcpStream::connect((address.as_str(), port))
            .await
            .map_err(|e| format!("TCP connect failed: {e}"))?;
        let client_addr = tcp
            .local_addr()
            .map_err(|e| format!("No local address: {e}"))?;

        let config = build_config(username, password, domain, width, height);
        let mut connector = ClientConnector::new(config, client_addr);

        // ── Handshake: begin → TLS upgrade → finalize (CredSSP/NLA) ───────────
        let mut framed = TokioFramed::new(tcp);
        let should_upgrade = connect_begin(&mut framed, &mut connector)
            .await
            .map_err(|e| format!("RDP negotiation failed: {e}"))?;

        let initial_stream = framed.into_inner_no_leftover();
        let (upgraded_stream, server_cert) = ironrdp_tls::upgrade(initial_stream, &server_name)
            .await
            .map_err(|e| format!("TLS handshake failed: {e}"))?;
        let server_public_key = ironrdp_tls::extract_tls_server_public_key(&server_cert)
            .ok_or_else(|| "Server certificate has no public key".to_string())?
            .to_vec();

        let upgraded = mark_as_upgraded(should_upgrade, &mut connector);
        let mut framed = TokioFramed::new(upgraded_stream);
        let mut network_client = ReqwestNetworkClient::new();

        let connection_result = connect_finalize(
            upgraded,
            connector,
            &mut framed,
            &mut network_client,
            ServerName::new(server_name),
            server_public_key,
            None,
        )
        .await
        .map_err(|e| format!("RDP connection failed (check credentials/NLA): {e} [{e:?}]"))?;

        let desktop = connection_result.desktop_size;
        let info = RdpConnectInfo {
            width: desktop.width,
            height: desktop.height,
        };

        let (tx, rx) = mpsc::unbounded_channel::<RdpCommand>();
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), RdpSessionHandle { tx });

        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            let reason = run_active_stage(framed, connection_result, on_frame, rx).await;
            sessions.lock().await.remove(&session_id);
            let _ = app.emit(
                "rdp-status",
                RdpStatus {
                    session_id: session_id.clone(),
                    status: "disconnected".into(),
                    message: reason,
                },
            );
        });

        Ok(info)
    }

    pub async fn send_input(&self, session_id: &str, events: Vec<RdpInputEvent>) -> Result<(), String> {
        let ops: Vec<Operation> = events.into_iter().filter_map(map_input).collect();
        if ops.is_empty() {
            return Ok(());
        }
        let sessions = self.sessions.lock().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| "RDP session not found".to_string())?;
        handle
            .tx
            .send(RdpCommand::Input(ops))
            .map_err(|_| "RDP session closed".to_string())
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        if let Some(handle) = self.sessions.lock().await.get(session_id) {
            let _ = handle.tx.send(RdpCommand::Disconnect);
        }
        Ok(())
    }

    pub async fn disconnect_all(&self) {
        let sessions = self.sessions.lock().await;
        for handle in sessions.values() {
            let _ = handle.tx.send(RdpCommand::Disconnect);
        }
    }
}

#[derive(Serialize, Clone)]
struct RdpStatus {
    #[serde(rename = "sessionId")]
    session_id: String,
    status: String,
    message: Option<String>,
}

/// Split a `DOMAIN\user` (or the mistyped `DOMAIN/user`) into the domain and a
/// bare username. CredSSP/NTLM wants the domain in its own field, not prefixed
/// onto the username, and does **not** accept a forward slash as the separator —
/// which is exactly what users type by habit. A domain parsed out of the
/// username wins over a separately-supplied one. A UPN (`user@domain`) is left
/// untouched; NTLM/Kerberos handle that form directly.
fn split_domain_user(username: String, domain: Option<String>) -> (Option<String>, String) {
    if let Some(idx) = username.find(['\\', '/']) {
        let dom = username[..idx].trim().to_string();
        let user = username[idx + 1..].trim().to_string();
        if !dom.is_empty() {
            return (Some(dom), user);
        }
        return (domain, user);
    }
    (domain, username)
}

/// Build a sensible default RDP [`Config`] for an NLA (CredSSP) session.
fn build_config(
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
) -> Config {
    let (domain, username) = split_domain_user(username, domain);
    Config {
        desktop_size: ironrdp::connector::DesktopSize { width, height },
        desktop_scale_factor: 0,
        enable_tls: true,
        enable_credssp: true,
        credentials: Credentials::UsernamePassword { username, password },
        domain,
        client_build: 0,
        client_name: "Termimus".to_string(),
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: Default::default(),
        compression_type: None,
        // We don't composite the remote cursor into the framebuffer; the canvas
        // shows the local browser cursor instead (it tracks the remote 1:1), so
        // software pointer rendering is off to avoid half-drawn cursor artifacts.
        enable_server_pointer: false,
        pointer_software_rendering: false,
        multitransport_flags: None,
    }
}

fn map_input(ev: RdpInputEvent) -> Option<Operation> {
    match ev {
        RdpInputEvent::MouseMove { x, y } => Some(Operation::MouseMove(MousePosition { x, y })),
        RdpInputEvent::MouseButton { button, down, .. } => {
            let btn = MouseButton::from_web_button(button)?;
            Some(if down {
                Operation::MouseButtonPressed(btn)
            } else {
                Operation::MouseButtonReleased(btn)
            })
        }
        RdpInputEvent::Wheel { vertical, units } => Some(Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: units,
        })),
        RdpInputEvent::Key { scancode, down } => {
            let sc = Scancode::from_u16(scancode);
            Some(if down {
                Operation::KeyPressed(sc)
            } else {
                Operation::KeyReleased(sc)
            })
        }
        RdpInputEvent::Unicode { ch, down } => Some(if down {
            Operation::UnicodeKeyPressed(ch)
        } else {
            Operation::UnicodeKeyReleased(ch)
        }),
    }
}

/// The per-session loop: read server PDUs and apply client input, painting the
/// decoded image region to the frontend on every graphics update. Returns an
/// optional human-readable termination reason.
async fn run_active_stage<S>(
    mut framed: ironrdp_tokio::Framed<S>,
    connection_result: ironrdp::connector::ConnectionResult,
    on_frame: Channel<InvokeResponseBody>,
    mut rx: mpsc::UnboundedReceiver<RdpCommand>,
) -> Option<String>
where
    S: ironrdp_tokio::FramedRead + ironrdp_tokio::FramedWrite + Sync,
{
    let desktop = connection_result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, desktop.width, desktop.height);
    let mut active_stage = ActiveStageBuilder {
        io_channel_id: connection_result.io_channel_id,
        user_channel_id: connection_result.user_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        static_channels: connection_result.static_channels,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();

    let mut input_db = Database::new();

    // Dirty rectangles are accumulated here and flushed to the frontend as one
    // batched message at ~60fps. WebView2 is slow per IPC call, so coalescing
    // many small bitmap tiles into a single send is the main perf lever — it
    // caps IPC at ~60 messages/sec regardless of how many tiles the server sends.
    let mut pending: Vec<u8> = Vec::new();
    let mut flush = tokio::time::interval(std::time::Duration::from_millis(16));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let outputs = tokio::select! {
            pdu = framed.read_pdu() => {
                let (action, payload) = match pdu {
                    Ok(v) => v,
                    Err(e) => return Some(format!("connection lost: {e}")),
                };
                match active_stage.process(&mut image, action, &payload) {
                    Ok(o) => o,
                    Err(e) => return Some(format!("session error: {e}")),
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(RdpCommand::Disconnect) | None => return None,
                    Some(RdpCommand::Input(ops)) => {
                        let events = input_db.apply(ops);
                        if events.is_empty() { continue; }
                        match active_stage.process_fastpath_input(&mut image, &events) {
                            Ok(o) => o,
                            Err(e) => return Some(format!("input error: {e}")),
                        }
                    }
                }
            }
            _ = flush.tick() => {
                if !pending.is_empty() {
                    let buf = std::mem::take(&mut pending);
                    if on_frame.send(InvokeResponseBody::Raw(buf)).is_err() {
                        return None; // frontend gone
                    }
                }
                continue;
            }
        };

        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    use ironrdp_tokio::FramedWrite;
                    if let Err(e) = framed.write_all(&frame).await {
                        return Some(format!("write failed: {e}"));
                    }
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    // Accumulate; the flush tick ships the batch.
                    pack_region_into(&mut pending, &image, &region);
                }
                ActiveStageOutput::Terminate(reason) => {
                    return Some(format!("{reason}"));
                }
                // Pointer variants: cursor is drawn locally by the browser.
                // DeactivateAll (resize/reactivation) is a follow-up.
                _ => {}
            }
        }
    }
}

/// Append a dirty rectangle to `out` as `[left u16][top u16][width u16][height
/// u16][RGBA…]`, all little-endian. Several rectangles are concatenated in one
/// buffer per flush; the frontend walks them in sequence and blits each with
/// `putImageData`. The clamped `rw`/`rh` guarantee exactly `rw*rh*4` pixel bytes
/// are written, so the stream never desyncs the following rectangles.
fn pack_region_into(out: &mut Vec<u8>, image: &DecodedImage, r: &InclusiveRectangle) {
    let img_w = image.width() as usize;
    let data = image.data();

    let left = r.left as usize;
    let top = r.top as usize;
    let right = (r.right as usize).max(left);
    let bottom = (r.bottom as usize).max(top);
    let rw = (right - left + 1).min(img_w.saturating_sub(left));
    let img_h = image.height() as usize;
    let rh = (bottom - top + 1).min(img_h.saturating_sub(top));
    if rw == 0 || rh == 0 {
        return;
    }

    out.reserve(8 + rw * rh * 4);
    out.extend_from_slice(&r.left.to_le_bytes());
    out.extend_from_slice(&r.top.to_le_bytes());
    out.extend_from_slice(&(rw as u16).to_le_bytes());
    out.extend_from_slice(&(rh as u16).to_le_bytes());

    for row in 0..rh {
        let src_y = top + row;
        let start = (src_y * img_w + left) * 4;
        let end = start + rw * 4;
        // end <= data.len() always holds given the clamping above.
        out.extend_from_slice(&data[start..end]);
    }
}
