// Termimus LAN web client — minimal terminal-only console that talks to the
// embedded HTTP/WebSocket server running inside the desktop app.
//
// Transport:
//   GET  /api/hosts?token=…   -> [{id,label,address,username,port,os_icon,tags}]
//   WS   /api/terminal?host_id=…&token=…&cols=…&rows=…
//        server -> client: binary = raw PTY bytes; text = JSON control
//        client -> server: binary = stdin bytes;   text = {type:"resize",cols,rows}
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var enc = new TextEncoder();
  var ICONS = window.DISTRO_ICONS || {};

  // ── Token handling ────────────────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var token = params.get("token") || localStorage.getItem("termimus_token") || "";

  function saveToken(t) {
    token = t;
    try { localStorage.setItem("termimus_token", t); } catch (_) {}
  }

  // ── Font size (persisted) ───────────────────────────────────────────────────
  var fontSize = parseInt(localStorage.getItem("termimus_fontsize"), 10);
  if (!(fontSize >= 9 && fontSize <= 22)) fontSize = 12;

  // ── Screen switching ──────────────────────────────────────────────────────
  function show(screen) {
    ["tokenScreen", "listScreen", "termScreen"].forEach(function (s) {
      $(s).classList.toggle("hidden", s !== screen);
    });
    var inTerm = screen === "termScreen";
    $("backBtn").classList.toggle("hidden", !inTerm);
    $("logo").classList.toggle("hidden", inTerm);
    $("termControls").classList.toggle("hidden", !inTerm);
    $("termStatus").classList.toggle("hidden", !inTerm);
  }

  // ── Distro icon resolution ──────────────────────────────────────────────────
  function resolveDistro(host) {
    if (host.os_icon && ICONS[host.os_icon]) return host.os_icon;
    var s = (
      (host.label || "") + " " +
      ((host.tags || []).join(" ")) + " " +
      (host.username || "")
    ).toLowerCase();
    var tests = [
      ["ubuntu", "ubuntu"], ["kali", "kali"], ["mint", "mint"],
      ["popos", "pop_os"], ["popos", "popos"], ["elementary", "elementary"],
      ["debian", "debian"], ["alpine", "alpine"], ["manjaro", "manjaro"],
      ["endeavour", "endeavour"], ["arch", "arch"], ["fedora", "fedora"],
      ["rocky", "rocky"], ["almalinux", "alma"], ["centos", "centos"],
      ["rhel", "rhel"], ["rhel", "redhat"], ["opensuse", "suse"],
      ["nixos", "nixos"], ["gentoo", "gentoo"], ["void", "void"],
      ["slackware", "slackware"], ["raspbian", "raspberry"], ["raspbian", "raspbian"],
      ["amazon", "amazon"], ["windows", "windows"],
    ];
    for (var i = 0; i < tests.length; i++) {
      if (s.indexOf(tests[i][1]) >= 0) return tests[i][0];
    }
    return "generic";
  }

  function iconEl(host) {
    var meta = ICONS[resolveDistro(host)] || ICONS.generic || { hex: "#2563eb", path: "" };
    var wrap = document.createElement("div");
    wrap.className = "host-icon";
    wrap.style.background = meta.hex;
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="' + meta.path + '"></path></svg>';
    return wrap;
  }

  // ── Host list + search ──────────────────────────────────────────────────────
  var allHosts = [];

  function renderHosts(filter) {
    var q = (filter || "").trim().toLowerCase();
    var list = $("hostList");
    list.innerHTML = "";

    var shown = allHosts.filter(function (h) {
      if (!q) return true;
      return (
        (h.label || "").toLowerCase().indexOf(q) >= 0 ||
        (h.address || "").toLowerCase().indexOf(q) >= 0 ||
        (h.username || "").toLowerCase().indexOf(q) >= 0 ||
        (h.tags || []).join(" ").toLowerCase().indexOf(q) >= 0
      );
    });

    if (!allHosts.length) {
      $("listNote").textContent = "No hosts configured in the desktop app.";
      return;
    }
    $("listNote").textContent = q
      ? shown.length + " of " + allHosts.length + " host" + (allHosts.length > 1 ? "s" : "")
      : allHosts.length + " host" + (allHosts.length > 1 ? "s" : "");

    shown.forEach(function (h) {
      var li = document.createElement("li");
      li.appendChild(iconEl(h));

      var body = document.createElement("div");
      body.className = "host-body";
      var label = document.createElement("div");
      label.className = "host-label";
      label.textContent = h.label || h.address;
      var sub = document.createElement("div");
      sub.className = "host-sub";
      sub.textContent = h.username + "@" + h.address + ":" + h.port;
      body.appendChild(label);
      body.appendChild(sub);
      li.appendChild(body);

      li.addEventListener("click", function () { openTerminal(h); });
      list.appendChild(li);
    });
  }

  function loadHosts() {
    show("listScreen");
    $("title").textContent = "Hosts";
    $("listNote").textContent = "Loading hosts…";
    $("listNote").classList.remove("error");
    $("hostList").innerHTML = "";

    fetch("/api/hosts?token=" + encodeURIComponent(token))
      .then(function (r) {
        if (r.status === 401) { throw new Error("unauthorized"); }
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
      })
      .then(function (hosts) {
        allHosts = hosts || [];
        renderHosts($("searchInput").value);
        checkVault();
      })
      .catch(function (e) {
        if (e.message === "unauthorized") {
          $("tokenErr").textContent = token ? "Invalid token." : "";
          show("tokenScreen");
          return;
        }
        $("listNote").textContent = "Failed to load hosts: " + e.message;
        $("listNote").classList.add("error");
      });
  }

  // ── Vault lock state + remote unlock ────────────────────────────────────────
  function checkVault() {
    fetch("/api/vault/status?token=" + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        var locked = !!(st && st.initialized && !st.unlocked);
        $("vaultBanner").classList.toggle("hidden", !locked);
      })
      .catch(function () {});
  }

  function openUnlock() {
    $("unlockErr").textContent = "";
    $("unlockInput").value = "";
    $("unlockModal").classList.remove("hidden");
    setTimeout(function () { $("unlockInput").focus(); }, 50);
  }
  function closeUnlock() {
    $("unlockModal").classList.add("hidden");
  }
  function submitUnlock() {
    var pw = $("unlockInput").value;
    if (!pw) { $("unlockErr").textContent = "Enter your master password."; return; }
    $("unlockErr").textContent = "Unlocking…";
    fetch("/api/vault/unlock?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.text().then(function (t) { throw new Error(t || "Unlock failed"); });
      })
      .then(function () {
        closeUnlock();
        $("vaultBanner").classList.add("hidden");
      })
      .catch(function (e) {
        $("unlockErr").textContent = String(e.message || e);
      });
  }

  $("vaultUnlockBtn").addEventListener("click", openUnlock);
  $("unlockCancel").addEventListener("click", closeUnlock);
  $("unlockConfirm").addEventListener("click", submitUnlock);
  $("unlockInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitUnlock();
  });

  // ── Terminal session ──────────────────────────────────────────────────────
  var term = null;
  var fit = null;
  var ws = null;
  var ro = null;

  function setStatus(msg, isErr) {
    var el = $("termStatus");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
  }

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN && term && term.cols >= 2 && term.rows >= 2) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  function refit() {
    if (!fit || !term) return;
    try { fit.fit(); } catch (_) { return; }
    sendResize();
  }

  function disposeTerm() {
    if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    if (term) { try { term.dispose(); } catch (_) {} term = null; fit = null; }
    $("terminal").innerHTML = "";
  }

  function openTerminal(host) {
    disposeTerm();
    show("termScreen");
    $("title").textContent = host.label || host.address;
    setStatus("Connecting…", false);

    term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: fontSize,
      scrollback: 5000,
      theme: { background: "#000000" },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($("terminal"));
    fit.fit();

    var cols = term.cols, rows = term.rows;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url =
      proto + "//" + location.host + "/api/terminal" +
      "?host_id=" + encodeURIComponent(host.id) +
      "&token=" + encodeURIComponent(token) +
      "&cols=" + cols + "&rows=" + rows;

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () { setStatus("Connected", false); };

    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === "progress") {
          setStatus(msg.message, !!msg.isError);
        } else if (msg.type === "error") {
          setStatus(msg.message, true);
          term.writeln("\r\n\x1b[31m" + msg.message + "\x1b[0m");
        } else if (msg.type === "closed") {
          setStatus("Session closed", false);
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };

    ws.onclose = function () { setStatus("Disconnected", true); };
    ws.onerror = function () { setStatus("Connection error", true); };

    term.onData(function (data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(enc.encode(data));
      }
    });

    // Debounced resize -> inform the server so curses apps reflow correctly.
    var resizeTimer = null;
    ro = new ResizeObserver(function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, 150);
    });
    ro.observe($("terminal"));
  }

  // ── Terminal controls (font size + scrolling) ───────────────────────────────
  function setFontSize(n) {
    fontSize = Math.max(9, Math.min(22, n));
    try { localStorage.setItem("termimus_fontsize", String(fontSize)); } catch (_) {}
    if (term) { term.options.fontSize = fontSize; refit(); }
  }

  $("fontDown").addEventListener("click", function () { setFontSize(fontSize - 1); });
  $("fontUp").addEventListener("click", function () { setFontSize(fontSize + 1); });
  $("pageUp").addEventListener("click", function () {
    if (term) term.scrollLines(-Math.max(1, term.rows - 1));
  });
  $("pageDown").addEventListener("click", function () {
    if (term) term.scrollLines(Math.max(1, term.rows - 1));
  });

  // ── Wiring ────────────────────────────────────────────────────────────────
  $("backBtn").addEventListener("click", function () {
    disposeTerm();
    loadHosts();
  });

  $("searchInput").addEventListener("input", function (e) {
    renderHosts(e.target.value);
  });

  $("tokenBtn").addEventListener("click", function () {
    var t = $("tokenInput").value.trim();
    if (!t) { $("tokenErr").textContent = "Please enter a token."; return; }
    saveToken(t);
    loadHosts();
  });
  $("tokenInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("tokenBtn").click();
  });

  // If the token came in the URL, persist it and drop it from the address bar
  // so it isn't left lingering in history/screenshots.
  if (params.get("token")) {
    saveToken(params.get("token"));
    history.replaceState(null, "", location.pathname);
  }

  if (token) {
    loadHosts();
  } else {
    show("tokenScreen");
  }
})();
