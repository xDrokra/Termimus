//! Embedded LAN web server.
//!
//! An opt-in HTTP + WebSocket server that runs **inside the desktop process** and
//! shares the exact same `Arc`-managed backend (`Database`, `VaultManager`,
//! `SessionManager`) as the Tauri command layer. It lets a plain browser on the
//! local network open an SSH terminal against any configured host, without the
//! master password ever leaving this machine: credentials are decrypted
//! server-side (only while the vault is unlocked) and only raw PTY bytes cross
//! the wire.
//!
//! Security posture (see also AGENTS.md / the feature plan):
//! - Disabled by default; started explicitly from the desktop Settings.
//! - Every `/api/*` route requires the pairing token (constant-time compared).
//! - Reuses `SessionManager`, so TOFU host-key verification still applies.
//! - LAN-only by design; traffic is plaintext, so intended for trusted networks.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex as StdMutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;

use crate::db::Database;
use crate::ssh::{SessionManager, SshEventSink, SshProgressPayload};
use crate::vault::VaultManager;

/// Static assets for the minimal web client (vendored xterm + hand-written
/// page). In debug builds rust-embed serves them from disk (live edits work);
/// release builds embed them into the binary.
#[derive(RustEmbed)]
#[folder = "../web-client"]
struct WebAssets;

/// Shared request context handed to every axum handler.
#[derive(Clone)]
struct WebCtx {
    db: Arc<Database>,
    vault: Arc<VaultManager>,
    ssh: Arc<SessionManager>,
    token: Arc<String>,
}

/// Outbound message queued from an `SshEventSink` to the WebSocket writer task.
enum WsOut {
    Data(Vec<u8>),
    Text(String),
}

/// `SshEventSink` that funnels session output to a single WebSocket client.
struct WsSink {
    tx: mpsc::UnboundedSender<WsOut>,
    /// Fired when the SSH session ends so the handler can close the socket.
    close: Arc<Notify>,
}

impl SshEventSink for WsSink {
    fn data(&self, _session_id: &str, bytes: Vec<u8>) {
        let _ = self.tx.send(WsOut::Data(bytes));
    }
    fn closed(&self, _session_id: &str) {
        let _ = self.tx.send(WsOut::Text(r#"{"type":"closed"}"#.to_string()));
        self.close.notify_one();
    }
    fn progress(&self, _session_id: &str, p: SshProgressPayload) {
        let json = serde_json::json!({
            "type": "progress",
            "step": p.step,
            "message": p.message,
            "isError": p.is_error,
        })
        .to_string();
        let _ = self.tx.send(WsOut::Text(json));
    }
    fn os_detected(&self, _host_id: &str, _os_icon: &str) {
        // The web client doesn't render host-list icons live; ignore.
    }
}

/// Lifecycle handle stored in `AppState`. Start/stop the server and read its
/// current bound port + token.
pub struct WebServerControl {
    inner: StdMutex<Option<Running>>,
}

struct Running {
    shutdown: oneshot::Sender<()>,
    port: u16,
    token: String,
}

impl Default for WebServerControl {
    fn default() -> Self {
        Self::new()
    }
}

impl WebServerControl {
    pub fn new() -> Self {
        Self {
            inner: StdMutex::new(None),
        }
    }

    /// `(running, bound_port, token)` — the latter two present only while running.
    pub fn status(&self) -> (bool, Option<u16>, Option<String>) {
        let g = self.inner.lock().unwrap();
        match g.as_ref() {
            Some(r) => (true, Some(r.port), Some(r.token.clone())),
            None => (false, None, None),
        }
    }

    /// Bind and serve. Stops any previously running instance first. Returns the
    /// actually bound port (useful when `port` was 0).
    pub async fn start(
        &self,
        db: Arc<Database>,
        vault: Arc<VaultManager>,
        ssh: Arc<SessionManager>,
        port: u16,
        token: String,
    ) -> Result<u16, String> {
        self.stop();

        let ctx = WebCtx {
            db,
            vault,
            ssh,
            token: Arc::new(token.clone()),
        };
        let app = build_router(ctx);

        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("Failed to bind the web server on port {port}: {e}"))?;
        let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);

        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service())
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
        });

        {
            let mut g = self.inner.lock().unwrap();
            *g = Some(Running {
                shutdown: tx,
                port: bound_port,
                token,
            });
        }
        Ok(bound_port)
    }

    /// Gracefully stop the server if running (no-op otherwise).
    pub fn stop(&self) {
        if let Some(r) = self.inner.lock().unwrap().take() {
            let _ = r.shutdown.send(());
        }
    }
}

fn build_router(ctx: WebCtx) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/vault/status", get(vault_status_handler))
        .route("/api/vault/unlock", post(vault_unlock_handler))
        .route("/api/hosts", get(list_hosts))
        .route("/api/terminal", get(terminal_ws))
        .fallback(static_handler)
        .with_state(ctx)
}

/// Constant-time token check. Returns false when no token is supplied.
fn token_ok(ctx: &WebCtx, provided: Option<&str>) -> bool {
    match provided {
        Some(t) => t.as_bytes().ct_eq(ctx.token.as_bytes()).into(),
        None => false,
    }
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn health() -> Response {
    Json(serde_json::json!({ "status": "ok", "app": "termimus" })).into_response()
}

async fn vault_status_handler(
    State(ctx): State<WebCtx>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let initialized = ctx.db.get_vault_meta("salt").ok().flatten().is_some();
    let unlocked = ctx.vault.is_unlocked();
    Json(serde_json::json!({ "initialized": initialized, "unlocked": unlocked })).into_response()
}

#[derive(Deserialize)]
struct UnlockBody {
    password: String,
}

async fn vault_unlock_handler(
    State(ctx): State<WebCtx>,
    Query(q): Query<TokenQuery>,
    Json(body): Json<UnlockBody>,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    match crate::commands::vault_unlock_with_password(&ctx.db, &ctx.vault, &body.password) {
        Ok(_) => Json(serde_json::json!({ "unlocked": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn list_hosts(State(ctx): State<WebCtx>, Query(q): Query<TokenQuery>) -> Response {
    if !token_ok(&ctx, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    match ctx.db.list_hosts() {
        Ok(hosts) => {
            let out: Vec<_> = hosts
                .into_iter()
                .map(|h| {
                    serde_json::json!({
                        "id": h.id,
                        "label": h.label,
                        "address": h.address,
                        "username": h.username,
                        "port": h.port,
                        "os_icon": h.os_icon,
                        "tags": h.tags,
                    })
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct TermQuery {
    token: Option<String>,
    host_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn terminal_ws(
    State(ctx): State<WebCtx>,
    Query(q): Query<TermQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| handle_terminal(socket, ctx, q))
}

fn error_json(msg: &str) -> String {
    serde_json::json!({ "type": "error", "message": msg }).to_string()
}

async fn handle_terminal(socket: WebSocket, ctx: WebCtx, q: TermQuery) {
    let (mut sender, mut receiver) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsOut>();

    // Writer task: drain the outbound queue onto the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let ws_msg = match msg {
                WsOut::Data(b) => Message::Binary(b.into()),
                WsOut::Text(s) => Message::Text(s.into()),
            };
            if sender.send(ws_msg).await.is_err() {
                break;
            }
        }
        let _ = sender.close().await;
    });

    // Resolve host + decrypted auth + optional jump host (vault must be unlocked).
    let (host, auth, jump) = match crate::commands::resolve_connection(&ctx.db, &ctx.vault, &q.host_id) {
        Ok(v) => v,
        Err(e) => {
            let _ = out_tx.send(WsOut::Text(error_json(&e)));
            drop(out_tx);
            let _ = writer.await;
            return;
        }
    };

    let session_id = Uuid::new_v4().to_string();
    let cols = q.cols.unwrap_or(80);
    let rows = q.rows.unwrap_or(24);
    let close = Arc::new(Notify::new());

    let sink: Arc<dyn SshEventSink> = Arc::new(WsSink {
        tx: out_tx.clone(),
        close: close.clone(),
    });

    let connect_res = ctx
        .ssh
        .connect(
            sink,
            ctx.db.clone(),
            session_id.clone(),
            Some(q.host_id.clone()),
            host.address,
            host.port,
            host.username,
            auth,
            cols,
            rows,
            jump,
        )
        .await;

    if let Err(e) = connect_res {
        let _ = out_tx.send(WsOut::Text(error_json(&e)));
        drop(out_tx);
        let _ = writer.await;
        return;
    }
    let _ = ctx.db.touch_host_last_connected(&q.host_id);

    // Pump: client -> SSH, until the client disconnects or the SSH session ends.
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Binary(b))) => {
                        let _ = ctx.ssh.write(&session_id, b.to_vec()).await;
                    }
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) {
                            if v.get("type").and_then(|x| x.as_str()) == Some("resize") {
                                let c = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                                let r = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                                let _ = ctx.ssh.resize(&session_id, c, r).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            _ = close.notified() => break,
        }
    }

    let _ = ctx.ssh.disconnect(&session_id).await;
    drop(out_tx);
    let _ = writer.await;
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WebAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                content.data.into_owned(),
            )
                .into_response()
        }
        None => match WebAssets::get("index.html") {
            Some(content) => (
                [(header::CONTENT_TYPE, "text/html".to_string())],
                content.data.into_owned(),
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, "not found").into_response(),
        },
    }
}

/// Best-effort primary LAN IPv4: open a UDP socket "towards" a public address
/// (no packets are actually sent) and read back the local address the OS would
/// route through. Returns `None` when offline / no route.
fn primary_lan_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

/// Candidate base URLs (no token) to show in the desktop pairing panel.
pub fn lan_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(ip) = primary_lan_ip() {
        urls.push(format!("http://{ip}:{port}"));
    }
    urls.push(format!("http://127.0.0.1:{port}"));
    urls
}
