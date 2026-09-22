"""BMC HTML5 KVM/SOL through the PXE hop, served on this API (no random localhost ports)."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import secrets
import threading
from typing import Any
from urllib.parse import urlencode, urlsplit

from fastapi import WebSocket
from fastapi.responses import Response

from . import pxe_hop

BMC_USER = "ADMIN"
_sessions: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

_HOP_SKIP = {
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-length",
    "content-encoding",
    "strict-transport-security",
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
}


def _inject_js(prefix: str, sess: dict[str, Any]) -> str:
    user = sess.get("bmc_user") or BMC_USER
    password = sess.get("password") or ""
    view = sess.get("view") or "kvm"
    auth = sess.get("csrf") or sess.get("token") or ""
    if view in ("kvm", "sol"):
        style = (
            "<style>html,body,#app{height:100%;width:100%;margin:0;overflow:hidden;background:#000}"
            "html.l12-console header.q-header,html.l12-console .q-header,html.l12-console .q-drawer,"
            "html.l12-console .q-toolbar,html.l12-console nav,html.l12-console .app-header,"
            "html.l12-console .page-header,html.l12-console aside.q-drawer{display:none!important}"
            "html.l12-console .q-page-container,html.l12-console .q-page,html.l12-console .full-window,"
            "html.l12-console .full-window-container,html.l12-console #app>div{padding:0!important;"
            "margin:0!important;height:100%!important;width:100%!important;max-height:none!important}"
            "html.l12-console #terminal-kvm,html.l12-console #terminal{"
            "position:fixed!important;inset:0!important;width:100%!important;height:100%!important;"
            "max-height:none!important;min-height:0!important;overflow:hidden!important;background:#000}"
            "html.l12-console canvas{display:block}"
            "</style>"
        )
    else:
        style = "<style>html,body{min-height:100%}</style>"
    return (
        style
        + "<script>(function(){"
        f"var PREFIX={prefix!r};"
        f"var USER={json.dumps(user)};"
        f"var PASS={json.dumps(password)};"
        f"var VIEW={json.dumps(view)};"
        f"var AUTH={json.dumps(auth)};"
        "var WS_HOST=location.port==='8001'?location.host:(location.hostname+':8001');"
        "document.cookie='XSRF-TOKEN='+(AUTH||'1')+'; path=/';"
        "document.cookie='IsAuthenticated=true; path=/';"
        "try{localStorage.setItem('storedUsername',USER);}catch(e){}"
        "try{sessionStorage.setItem('l12-kvm-prefix',PREFIX);}catch(e){}"
        "function rewrite(u){"
        "if(typeof u!=='string'||!u)return u;"
        "if(/^(data:|blob:|javascript:)/i.test(u))return u;"
        "try{"
        "var p=new URL(u,location.href);"
        "var ip=/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(p.hostname);"
        "var isWs=p.protocol==='ws:'||p.protocol==='wss:';"
        "if(isWs||p.host===location.host||ip){"
        "if(p.pathname.indexOf(PREFIX)!==0)p.pathname=PREFIX+p.pathname;"
        "if(isWs){p.protocol=location.protocol==='https:'?'wss:':'ws:';p.host=WS_HOST;}"
        "else{if(p.protocol==='https:')p.protocol=location.protocol;p.host=location.host;}"
        "return p.toString();"
        "}"
        "}catch(e){}"
        "return u;"
        "}"
        "var W=window.WebSocket;"
        "window.WebSocket=function(url,protocols){"
        "url=rewrite(String(url));"
        "return protocols!==undefined?new W(url,protocols):new W(url);"
        "};"
        "window.WebSocket.prototype=W.prototype;"
        "window.WebSocket.CONNECTING=W.CONNECTING;window.WebSocket.OPEN=W.OPEN;"
        "window.WebSocket.CLOSING=W.CLOSING;window.WebSocket.CLOSED=W.CLOSED;"
        "var F=window.fetch;"
        "window.fetch=function(input,init){"
        "init=init||{};"
        "var hdrs=new Headers(init.headers||{});"
        "if(AUTH){hdrs.set('X-Auth-Token',AUTH);hdrs.set('X-XSRF-TOKEN',AUTH);}"
        "init.headers=hdrs;init.credentials='include';"
        "if(typeof input==='string')input=rewrite(input);"
        "else if(input&&input.url)input=new Request(rewrite(input.url),input);"
        "return F(input,init);"
        "};"
        "var xo=XMLHttpRequest.prototype.open;"
        "var xsend=XMLHttpRequest.prototype.send;"
        "var xset=XMLHttpRequest.prototype.setRequestHeader;"
        "XMLHttpRequest.prototype.open=function(method,url){"
        "arguments[1]=rewrite(String(url));"
        "return xo.apply(this,arguments);"
        "};"
        "XMLHttpRequest.prototype.send=function(body){"
        "if(AUTH){try{xset.call(this,'X-Auth-Token',AUTH);}catch(e){}try{xset.call(this,'X-XSRF-TOKEN',AUTH);}catch(e){}}"
        "return xsend.apply(this,arguments);"
        "};"
        "if(window.EventSource){var E=window.EventSource;window.EventSource=function(url,cfg){return new E(rewrite(String(url)),cfg);};}"
        "function setVal(el,v){"
        "if(!el)return;"
        "var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');"
        "if(d&&d.set)d.set.call(el,v);else el.value=v;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));"
        "el.dispatchEvent(new Event('change',{bubbles:true}));"
        "try{el.dispatchEvent(new InputEvent('input',{bubbles:true,data:v,inputType:'insertFromPaste'}));}catch(e){}"
        "}"
        "function paintForm(){"
        "var pass=document.querySelector('input[type=password]');"
        "if(!pass)return false;"
        "var user=null;"
        "document.querySelectorAll('input').forEach(function(el){"
        "var t=(el.type||'text').toLowerCase();"
        "if(el!==pass&&(t==='text'||t==='email'||t==='username'||t==='')) user=user||el;"
        "});"
        "if(USER) setVal(user,USER);"
        "if(PASS) setVal(pass,PASS);"
        "return true;"
        "}"
        "function goAfter(){"
        "var hash=VIEW==='sol'?'#/console/serial-over-lan-console':VIEW==='bmc'?'#/':'#/console/kvm';"
        "if(location.hash!==hash) location.hash=hash;"
        "}"
        "function hideChrome(){"
        "if(VIEW!=='kvm'&&VIEW!=='sol')return;"
        "if(document.querySelector('input[type=password]'))return;"
        "document.documentElement.classList.add('l12-console');"
        "if(document.body)document.body.classList.add('l12-console');"
        "}"
        "function findRfb(){"
        "if(window.__l12rfb&&typeof window.__l12rfb.clipboardPasteFrom==='function')return window.__l12rfb;"
        "if(window.UI&&window.UI.rfb&&typeof window.UI.rfb.clipboardPasteFrom==='function'){"
        "window.__l12rfb=window.UI.rfb;return window.__l12rfb;}"
        "var nodes=document.querySelectorAll('canvas, #terminal-kvm, #noVNC_container, .full-window');"
        "for(var i=0;i<nodes.length;i++){"
        "var p=nodes[i];"
        "while(p){"
        "for(var k in p){"
        "try{var v=p[k];"
        "if(v&&typeof v.clipboardPasteFrom==='function'){window.__l12rfb=v;return v;}"
        "}catch(e){}"
        "}"
        "var vm=p.__vue__||(p.__vueParentComponent&&p.__vueParentComponent.ctx);"
        "if(vm){"
        "var r=vm.rfb||vm.$rfb||(vm.kvm&&vm.kvm.rfb);"
        "if(r&&typeof r.clipboardPasteFrom==='function'){window.__l12rfb=r;return r;}"
        "}"
        "p=p.parentElement;"
        "}"
        "}"
        "return null;"
        "}"
        "function findTerm(){"
        "var xt=document.querySelector('.xterm');"
        "if(!xt)return null;"
        "if(xt._terminal||xt.terminal)return xt._terminal||xt.terminal;"
        "for(var k in xt){try{var v=xt[k];if(v&&typeof v.write==='function')return v;}catch(e){}}"
        "return null;"
        "}"
        "function hookClipboard(rfb){"
        "if(!rfb||rfb.__l12clipHook)return;"
        "rfb.__l12clipHook=true;"
        "try{rfb.addEventListener('clipboard',function(e){"
        "var t=(e&&e.detail&&e.detail.text)||'';"
        "window.__l12clip=t;"
        "try{window.parent.postMessage({type:'l12-clipboard',text:t},'*');}catch(err){}"
        "});}catch(e){}"
        "}"
        "function fitKvm(){"
        "var rfb=findRfb();"
        "if(!rfb)return;"
        "hookClipboard(rfb);"
        "try{rfb.scaleViewport=true;}catch(e){}"
        "try{rfb.clipViewport=false;}catch(e){}"
        "try{rfb.resizeSession=false;}catch(e){}"
        "try{if(rfb._display&&typeof rfb._display.autoscale==='function'){"
        "var box=document.getElementById('terminal-kvm')||document.getElementById('terminal')||document.body;"
        "rfb._display.autoscale(box.clientWidth||window.innerWidth,box.clientHeight||window.innerHeight);"
        "}}catch(e){}"
        "try{if(typeof rfb.focus==='function')rfb.focus();}catch(e){}"
        "}"
        "var fitting=false;"
        "function fitConsole(){"
        "if(fitting||(VIEW!=='kvm'&&VIEW!=='sol'))return;"
        "fitting=true;"
        "hideChrome();"
        "var h=window.innerHeight,w=window.innerWidth;"
        "['#terminal-kvm','#terminal','.full-window','.full-window-container'].forEach(function(sel){"
        "document.querySelectorAll(sel).forEach(function(el){"
        "el.style.position='fixed';"
        "el.style.left='0';el.style.top='0';"
        "el.style.right='0';el.style.bottom='0';"
        "el.style.width=w+'px';"
        "el.style.height=h+'px';"
        "el.style.maxHeight='none';"
        "el.style.overflow='hidden';"
        "});"
        "});"
        "fitKvm();"
        "fitting=false;"
        "}"
        "window.addEventListener('resize',fitConsole);"
        "setInterval(fitConsole,800);"
        "setTimeout(fitConsole,300);"
        "setTimeout(fitConsole,1200);"
        "function apiLogin(done){"
        "var users=[];"
        "[USER,'ADMIN','admin','root'].forEach(function(u){if(u&&users.indexOf(u)<0)users.push(u);});"
        "var jobs=[];"
        "users.forEach(function(u){"
        "jobs.push({url:PREFIX+'/login',body:JSON.stringify({username:u,password:PASS})});"
        "jobs.push({url:PREFIX+'/login',body:JSON.stringify({data:[u,PASS]})});"
        "});"
        "var i=0;"
        "function next(){"
        "if(i>=jobs.length){done(false);return;}"
        "var j=jobs[i++];"
        "F(j.url,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:j.body}).then(function(r){"
        "if(r.status<400){r.json().then(function(b){done(true,b&&b.token);}).catch(function(){done(true,'');});return;}"
        "next();"
        "}).catch(function(){next();});"
        "}"
        "next();"
        "}"
        "function vueLogin(){"
        "var pass=document.querySelector('input[type=password]');"
        "if(!pass)return false;"
        "var p=pass;"
        "while(p){"
        "var vm=p.__vue__||(p.__vueParentComponent&&p.__vueParentComponent.ctx);"
        "if(vm&&vm.userInfo){"
        "vm.userInfo.username=USER;vm.userInfo.password=PASS;"
        "if(typeof vm.login==='function'){vm.login();return true;}"
        "}"
        "p=p.parentElement;"
        "}"
        "return false;"
        "}"
        "function setAuthCookies(token){"
        "try{sessionStorage.setItem('l12-kvm-prefix',PREFIX);}catch(e){}"
        "var path='; path=/';"
        "if(token) document.cookie='XSRF-TOKEN='+token+path;"
        "document.cookie='IsAuthenticated=true'+path;"
        "}"
        "var painted=false;"
        "var paintIv=setInterval(function(){"
        "if(paintForm()){painted=true;vueLogin();}"
        "},400);"
        "setTimeout(function(){clearInterval(paintIv);},15000);"
        "try{sessionStorage.setItem('l12-kvm-prefix',PREFIX);}catch(e){}"
        "apiLogin(function(ok,token){if(!ok)return;setAuthCookies(token);setTimeout(goAfter,300);});"
        "function l12readScale(){"
        "try{var n=Number(sessionStorage.getItem('l12-console-scale'));if(n>=1&&n<=3)return n;}catch(e){}"
        "return window.__l12Scale||1;"
        "}"
        "function l12applyScale(s){"
        "s=Number(s);if(!(s>=1&&s<=3))s=1;"
        "window.__l12Scale=s;"
        "try{sessionStorage.setItem('l12-console-scale',String(s));}catch(e){}"
        "document.querySelectorAll('[data-l12-zoom]').forEach(function(el){"
        "el.style.zoom='';el.style.transform='';el.removeAttribute('data-l12-zoom');"
        "});"
        "var term=findTerm();"
        "if(term){"
        "var fs=Math.max(11,Math.round(13*s));"
        "try{term.setOption('fontSize',fs);}catch(e){try{term.options.fontSize=fs;}catch(e2){}}"
        "try{if(term.fit&&typeof term.fit==='function')term.fit();}catch(e){}"
        "try{if(window.FitAddon){}}catch(e){}"
        "}"
        "fitConsole();"
        "}"
        "function sendCtrlV(rfb){"
        "if(!rfb||typeof rfb.sendKey!=='function')return;"
        "try{"
        "rfb.sendKey(0xffe3,'ControlLeft',true);"
        "rfb.sendKey(0x0076,'KeyV',true);"
        "rfb.sendKey(0x0076,'KeyV',false);"
        "rfb.sendKey(0xffe3,'ControlLeft',false);"
        "}catch(e){}"
        "}"
        "function pasteText(text){"
        "text=String(text||'');"
        "if(!text)return;"
        "window.__l12clip=text;"
        "var rfb=findRfb();"
        "if(rfb){"
        "try{rfb.clipboardPasteFrom(text);}catch(e){}"
        "try{if(typeof rfb.focus==='function')rfb.focus();}catch(e){}"
        "setTimeout(function(){sendCtrlV(rfb);},80);"
        "}"
        "var term=findTerm();"
        "if(term){"
        "try{if(typeof term.paste==='function')term.paste(text);"
        "else if(typeof term.write==='function')term.write(text);}"
        "catch(e){}"
        "}"
        "}"
        "window.addEventListener('message',function(e){"
        "var d=e.data||{};"
        "if(d.type==='l12-scale')l12applyScale(d.scale);"
        "if(d.type==='l12-clipboard-paste')pasteText(d.text);"
        "if(d.type==='l12-clipboard-request'){"
        "try{window.parent.postMessage({type:'l12-clipboard',text:window.__l12clip||''},'*');}catch(err){}"
        "}"
        "});"
        "try{window.parent.postMessage({type:'l12-scale-ready'},'*');}catch(e){}"
        "l12applyScale(l12readScale());"
        "try{new MutationObserver(function(){hideChrome();fitKvm();}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}"
        "setInterval(function(){if(findTerm())l12applyScale(l12readScale());fitKvm();},2000);"
        "})();</script>"
    )


def _rewrite_cookie(value: str, prefix: str) -> str:
    name = value.split("=", 1)[0].strip().lower()
    path = "/" if name in {"xsrf-token", "isauthenticated"} else f"{prefix}/"
    if re.search(r"path=", value, re.I):
        value = re.sub(r"[Pp]ath=/[^;]*", f"Path={path}", value)
    else:
        value += f"; Path={path}"
    value = re.sub(r";\s*[Dd]omain=[^;]*", "", value)
    value = re.sub(r";\s*[Ss]ecure", "", value, flags=re.I)
    value = re.sub(r";\s*[Ss]ame[Ss]ite=[^;]*", "", value)
    # Vue js-cookie must read XSRF-TOKEN / IsAuthenticated
    if name in {"xsrf-token", "isauthenticated"}:
        value = re.sub(r";\s*HttpOnly", "", value, flags=re.I)
    return value


def _rewrite_body(data: bytes, ctype: str, sess: dict[str, Any]) -> bytes:
    prefix: str = sess["prefix"]
    bmc = (sess.get("bmc_ip") or "").encode()
    kind = (ctype or "").lower()
    textish = any(x in kind for x in ("html", "javascript", "json", "xml", "css", "text/"))
    if not textish or not data:
        return data
    if bmc:
        data = data.replace(b"https://" + bmc, prefix.encode())
        data = data.replace(b"http://" + bmc, prefix.encode())
    if "html" in kind:
        inject = _inject_js(prefix, sess) + f'<base href="{prefix}/">'
        try:
            html = data.decode("utf-8")
        except UnicodeDecodeError:
            html = data.decode("utf-8", "replace")

        def _attr(match: re.Match[str]) -> str:
            attr, quote, url = match.group(1), match.group(2), match.group(3)
            if url.startswith(("http://", "https://", "//", "data:", "mailto:", prefix)):
                return match.group(0)
            if url.startswith("/"):
                return f"{attr}={quote}{prefix}{url}{quote}"
            return match.group(0)

        html = re.sub(r"\b(src|href|action)=([\"'])([^\"']+)\2", _attr, html, flags=re.I)
        lowered = html.lower()
        idx = lowered.find("<head")
        if idx >= 0:
            gt = html.find(">", idx)
            if gt >= 0:
                html = html[: gt + 1] + inject + html[gt + 1 :]
        else:
            html = inject + html
        data = html.encode("utf-8")
    return data


def _combine_cookies(*parts: str) -> str:
    jar: dict[str, str] = {}
    skip = {"path", "domain", "expires", "max-age", "secure", "httponly", "samesite"}
    for part in parts:
        if not part:
            continue
        for piece in part.split(";"):
            piece = piece.strip()
            if not piece or "=" not in piece:
                continue
            k, _, v = piece.partition("=")
            if k.strip().lower() in skip:
                continue
            jar[k.strip()] = v.strip()
    return "; ".join(f"{k}={v}" for k, v in jar.items() if v)


def _cookie_from(headers: dict[str, str]) -> str:
    raw = headers.get("set-cookie") or headers.get("Set-Cookie") or ""
    if not raw:
        return ""
    return raw.split(";", 1)[0]


def _login(bmc_ip: str, password: str, extra_user: str | None, tunnel_key: str) -> tuple[str, str, str]:
    """Return (cookie, token, csrf). NVIDIA / AMI / OpenBMC / Redfish."""
    users: list[str] = []
    for u in (extra_user, BMC_USER, "admin", "root"):
        if u and u not in users:
            users.append(u)
    last = ""
    attempts: list[tuple[str, str, bytes, dict[str, str]]] = []
    for user in users:
        pw = password or ""
        # NVIDIA webui-vue posts {username, password} to /login
        attempts.append(
            ("POST", "/login", json.dumps({"username": user, "password": pw}).encode(), {"Content-Type": "application/json"})
        )
        attempts.append(
            ("POST", "/login", json.dumps({"data": [user, pw]}).encode(), {"Content-Type": "application/json"})
        )
        attempts.append(
            ("POST", "/api/session", json.dumps({"username": user, "password": pw}).encode(), {"Content-Type": "application/json"})
        )
        attempts.append(
            (
                "POST",
                "/login",
                urlencode({"username": user, "password": pw}).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
        )
        attempts.append(
            (
                "POST",
                "/redfish/v1/SessionService/Sessions",
                json.dumps({"UserName": user, "Password": pw}).encode(),
                {"Content-Type": "application/json"},
            )
        )
    for method, path, body, hdrs in attempts:
        status, headers, data = pxe_hop.https_request(
            bmc_ip, method, path, headers=hdrs, body=body, timeout=8, tunnel_key=tunnel_key, prefer_exec=True
        )
        cookie_hdr = headers.get("set-cookie") or ""
        parts = [p.strip() for p in cookie_hdr.split("\n") if p.strip()]
        names = " ".join(p.split("=", 1)[0].lower() for p in parts)
        cookie = "; ".join(_cookie_from({"set-cookie": p}) for p in parts if _cookie_from({"set-cookie": p}))
        token = headers.get("x-auth-token") or ""
        csrf = headers.get("x-csrftoken") or headers.get("csrf-token") or ""
        try:
            payload = json.loads(data.decode("utf-8", "replace") or "{}")
            if isinstance(payload, dict) and payload.get("token") and not csrf:
                csrf = str(payload["token"])
        except Exception:
            payload = {}
        ok_cookie = any(n in names for n in ("session", "xsrf-token", "isauthenticated", "qsessionid"))
        if status < 400 and (ok_cookie or token or csrf):
            if token and not cookie:
                cookie = f"X-Auth-Token={token}"
            return cookie, token, csrf
        last = data[:180].decode("utf-8", "replace")
    raise RuntimeError(f"BMC login failed {last}")


def start_kvm(node_id: str, bmc_ip: str, password: str, bmc_user: str | None) -> dict[str, Any]:
    tunnel_key = f"kvm-{node_id}"
    pxe_hop.open_https_tunnel(tunnel_key, bmc_ip, 443)
    cookie = ""
    token_hdr = ""
    csrf = ""
    try:
        cookie, token_hdr, csrf = _login(bmc_ip, password, bmc_user, tunnel_key)
        if cookie.startswith("X-Auth-Token=") and not token_hdr:
            token_hdr = cookie.split("=", 1)[1]
    except Exception:
        cookie = ""
    token = secrets.token_urlsafe(18)
    prefix = f"/api/provision/kvm/{token}"
    session = {
        "node_id": node_id,
        "bmc_ip": bmc_ip,
        "cookie": cookie,
        "token": token_hdr,
        "csrf": csrf,
        "password": password,
        "bmc_user": bmc_user or BMC_USER,
        "tunnel_key": tunnel_key,
        "prefix": prefix,
        "view": "kvm",
    }
    with _lock:
        _sessions[token] = session
    return {
        "token": token,
        "path": prefix + "/",
        "bmc_ip": bmc_ip,
        "user": session["bmc_user"],
    }


def get_session(token: str) -> dict[str, Any]:
    with _lock:
        sess = _sessions.get(token)
    if not sess:
        raise KeyError("KVM session expired — open KVM again")
    return sess


def http_proxy(
    token: str,
    path: str,
    method: str,
    query: str,
    headers: dict[str, str],
    body: bytes,
) -> Response:
    try:
        sess = get_session(token)
    except KeyError as exc:
        return Response(str(exc), status_code=410, media_type="text/plain")
    bmc_path = "/" + (path or "")
    qs = query or ""
    if "view=" in qs:
        if "view=sol" in qs:
            sess["view"] = "sol"
        elif "view=bmc" in qs:
            sess["view"] = "bmc"
        elif "view=kvm" in qs:
            sess["view"] = "kvm"
        # drop view= so the BMC does not see it
        parts = [p for p in qs.split("&") if p and not p.startswith("view=")]
        qs = "&".join(parts)
    if qs:
        bmc_path += "?" + qs
    hdrs = {
        "Accept": headers.get("accept") or headers.get("Accept") or "*/*",
        "Cookie": sess.get("cookie") or "",
    }
    if sess.get("csrf"):
        hdrs["X-CSRFTOKEN"] = sess["csrf"]
        hdrs["X-Csrf-Token"] = sess["csrf"]
        hdrs["X-XSRF-TOKEN"] = sess["csrf"]
        hdrs["X-Auth-Token"] = sess.get("token") or sess["csrf"]
    ctype_in = headers.get("content-type") or headers.get("Content-Type")
    if body:
        hdrs["Content-Type"] = ctype_in or "application/json"
    elif ctype_in:
        hdrs["Content-Type"] = ctype_in
    if sess.get("token"):
        hdrs["X-Auth-Token"] = sess["token"]
    incoming_cookie = headers.get("cookie") or headers.get("Cookie")
    hdrs["Cookie"] = _combine_cookies(sess.get("cookie") or "", incoming_cookie or "")
    try:
        status, rh, data = pxe_hop.https_request(
            sess["bmc_ip"],
            method,
            bmc_path,
            headers=hdrs,
            body=body or None,
            timeout=30,
            tunnel_key=sess["tunnel_key"],
            prefer_exec=False,
        )
    except pxe_hop.NeedsHop as exc:
        return Response(str(exc), status_code=401, media_type="text/plain")
    except Exception as exc:
        return Response(f"BMC tunnel failed: {exc}", status_code=502, media_type="text/plain")
    if status in (401, 403) and sess.get("password") is not None:
        try:
            cookie, token_hdr, csrf = _login(sess["bmc_ip"], sess["password"], sess.get("bmc_user"), sess["tunnel_key"])
            sess["cookie"] = cookie
            sess["token"] = token_hdr
            sess["csrf"] = csrf
            if cookie.startswith("X-Auth-Token=") and not token_hdr:
                sess["token"] = cookie.split("=", 1)[1]
            hdrs["Cookie"] = cookie
            if sess.get("token"):
                hdrs["X-Auth-Token"] = sess["token"]
            if sess.get("csrf"):
                hdrs["X-CSRFTOKEN"] = sess["csrf"]
            status, rh, data = pxe_hop.https_request(
                sess["bmc_ip"],
                method,
                bmc_path,
                headers=hdrs,
                body=body or None,
                timeout=30,
                tunnel_key=sess["tunnel_key"],
                prefer_exec=False,
            )
        except Exception:
            pass
    ctype = rh.get("content-type", "")
    data = _rewrite_body(data, ctype, sess)
    out_headers: dict[str, str] = {}
    prefix = sess["prefix"]
    cookie_lines = [c.strip() for c in (rh.get("set-cookie") or "").split("\n") if c.strip()]
    for k, v in rh.items():
        if k in _HOP_SKIP or k == "set-cookie":
            continue
        if k == "location" and v:
            parts = urlsplit(v)
            loc = parts.path or "/"
            if not loc.startswith(prefix):
                loc = prefix + loc
            if parts.query:
                loc += "?" + parts.query
            v = loc
        try:
            v.encode("latin-1")
        except UnicodeEncodeError:
            continue
        out_headers[k] = v
    out_headers["Cache-Control"] = "no-store"
    resp = Response(content=data, status_code=status, headers=out_headers, media_type=ctype or None)

    def _add_cookie(val: str) -> None:
        try:
            resp.headers.append("set-cookie", val)
        except Exception:
            resp.raw_headers.append((b"set-cookie", val.encode("latin-1")))

    for c in cookie_lines:
        _add_cookie(_rewrite_cookie(c, prefix))
    if sess.get("csrf") and not any("xsrf-token=" in c.lower() for c in cookie_lines):
        _add_cookie(_rewrite_cookie(f"XSRF-TOKEN={sess['csrf']}", prefix))
        _add_cookie(_rewrite_cookie("IsAuthenticated=true", prefix))
    return resp


def _ws_connect_kwargs(headers: dict[str, str]) -> dict[str, Any]:
    import websockets

    params = inspect.signature(websockets.connect).parameters
    if "additional_headers" in params:
        return {"additional_headers": headers}
    if "extra_headers" in params:
        return {"extra_headers": headers}
    return {}


async def ws_proxy(websocket: WebSocket, token: str, path: str) -> None:
    try:
        sess = get_session(token)
    except KeyError:
        await websocket.close(code=4401)
        return
    proto = websocket.headers.get("sec-websocket-protocol")
    sub = proto.split(",")[0].strip() if proto else None
    bmc_path = "/" + (path or "")
    query = websocket.url.query
    if query:
        bmc_path += "?" + query
    tunnel = pxe_hop.open_https_tunnel(sess["tunnel_key"], sess["bmc_ip"], 443)
    import socket as _socket
    import ssl as _ssl

    import websockets

    ctx = _ssl._create_unverified_context()
    raw = await asyncio.to_thread(_socket.create_connection, ("127.0.0.1", tunnel), 20)
    url = f"wss://{sess['bmc_ip']}{bmc_path}"
    headers = {"Host": sess["bmc_ip"]}
    headers["Cookie"] = _combine_cookies(sess.get("cookie") or "", websocket.headers.get("cookie") or "")
    token = sess.get("token") or sess.get("csrf") or ""
    if token:
        headers["X-Auth-Token"] = token
        headers["X-XSRF-TOKEN"] = token
    kw: dict[str, Any] = {
        "sock": raw,
        "ssl": ctx,
        "server_hostname": sess["bmc_ip"],
        "proxy": None,
        "compression": None,
        "open_timeout": 30,
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": 8 * 1024 * 1024,
        **_ws_connect_kwargs(headers),
    }
    if sub:
        kw["subprotocols"] = [sub]
    try:
        bmc = await websockets.connect(url, **kw)
    except Exception:
        try:
            raw.close()
        except Exception:
            pass
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
        return
    if sub:
        await websocket.accept(subprotocol=sub)
    else:
        await websocket.accept()

    async def browser_to_bmc() -> None:
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if "text" in msg and msg["text"] is not None:
                    await bmc.send(msg["text"])
                elif "bytes" in msg and msg["bytes"] is not None:
                    await bmc.send(msg["bytes"])
        except Exception:
            pass

    async def bmc_to_browser() -> None:
        try:
            async for item in bmc:
                if isinstance(item, bytes):
                    await websocket.send_bytes(item)
                else:
                    await websocket.send_text(item)
        except Exception:
            pass

    try:
        await asyncio.wait(
            [
                asyncio.create_task(browser_to_bmc()),
                asyncio.create_task(bmc_to_browser()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        try:
            await bmc.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
