import asyncio
import json
import re
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import aiohttp
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.routing import NoMatchFound
from jinja2 import pass_context

from login import CosmoAuth, send_otp, verify_otp_and_login

BASE_DIR = Path(__file__).resolve().parent
app = FastAPI()

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
static_dir = BASE_DIR / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


_orig_url_for = templates.env.globals["url_for"]


@pass_context
def _compat_url_for(context: dict, name: str, **path_params):
    if "filename" in path_params and "path" not in path_params:
        path_params["path"] = path_params.pop("filename")
    try:
        return _orig_url_for(context, name, **path_params)
    except NoMatchFound:
        if name == "static":
            rel = str(
                path_params.get("path") or path_params.get("filename") or ""
            ).lstrip("/")
            return f"/static/{rel}"
        raise


templates.env.globals["url_for"] = _compat_url_for

CACHE_DIR = BASE_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

cosmo_auth = CosmoAuth(BASE_DIR / "auth.json")

BASE_HEADERS = {
    "User-Agent": "cosmo/524 CFNetwork/1498.700.2 Darwin/23.6.0",
}

CHANNELS_URL = "https://api.cosmo.fans/bff/v4/channels/messages"
NDJSON_URL_TEMPLATE = (
    "https://api.cosmo.fans/bff/v3/channels/messages/{artist_member_id}/sync-events/latest.ndjson"
)
REPLY_COUNT_URL_TEMPLATE = (
    "https://api.cosmo.fans/bff/v3/channels/messages/{artist_member_id}/reply-count"
)
STICKERS_URL = "https://api.cosmo.fans/bff/v3/artists/tripleS/stickers"
SEND_REPLY_URL_TEMPLATE = (
    "https://api.cosmo.fans/bff/v4/channels/messages/{artist_member_id}/{message_id}/replies"
)


def nfc(value):
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [nfc(item) for item in value]
    if isinstance(value, dict):
        return {nfc(k): nfc(v) for k, v in value.items()}
    return value


def decode_content(raw_content):
    if isinstance(raw_content, str):
        try:
            decoded = raw_content.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            decoded = raw_content
        return nfc(decoded)
    return nfc(raw_content)


def get_cache_file(member_id) -> Path:
    safe_id = Path(str(member_id)).name
    return CACHE_DIR / f"{safe_id}.json"


def load_cached_records(cache_path: Path) -> list[dict]:
    if not cache_path.exists():
        return []
    try:
        with cache_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return nfc(data)
    except (OSError, json.JSONDecodeError):
        pass
    return []


def extract_after_cursor(cached_records: list[dict]) -> str:
    for item in reversed(cached_records):
        if isinstance(item, dict) and item.get("eof") is True:
            to_cursor = item.get("toCursor")
            if to_cursor is not None and str(to_cursor).strip() != "":
                return nfc(str(to_cursor))
    return "0"


def merge_records(existing: list[dict], incoming: list[dict]) -> list[dict]:
    if not existing:
        return nfc(incoming)
    if not incoming:
        return nfc(existing)
    merged = [
        rec
        for rec in existing
        if not (isinstance(rec, dict) and rec.get("eof") is True)
    ]
    seen_keys = set()

    for rec in merged:
        if not isinstance(rec, dict):
            continue
        msg = rec.get("message") or {}
        key = (
            msg.get("syncId")
            or f"{rec.get('op', '')}:{rec.get('cursor', '')}:{msg.get('id', '')}"
        )
        seen_keys.add(key)
    for rec in incoming:
        if not isinstance(rec, dict) or rec.get("eof") is True:
            continue
        msg = rec.get("message") or {}
        key = (
            msg.get("syncId")
            or f"{rec.get('op', '')}:{rec.get('cursor', '')}:{msg.get('id', '')}"
        )
        if key not in seen_keys:
            seen_keys.add(key)
            merged.append(rec)
    for rec in reversed(incoming):
        if isinstance(rec, dict) and rec.get("eof") is True:
            merged.append(rec)
            break
    return nfc(merged)


async def fetch_member_ndjson(
    session: aiohttp.ClientSession,
    member: dict,
    ndjson_headers: dict,
) -> dict:
    member_id = nfc(member.get("artistMemberId"))
    artist_member_name = nfc(member.get("artistMemberName") or str(member_id))
    original_name = nfc(member.get("originalName") or "")
    profile_image_url = nfc(member.get("profileImageUrl") or "")
    last_msg = (
        member.get("lastMessage")
        if isinstance(member.get("lastMessage"), dict)
        else {}
    )
    last_message_id = nfc(str(last_msg.get("id") or ""))

    cache_path = get_cache_file(member_id)
    cached_records = load_cached_records(cache_path)
    after_cursor = extract_after_cursor(cached_records)

    ndjson_url = NDJSON_URL_TEMPLATE.format(artist_member_id=member_id)
    async with session.get(
        ndjson_url,
        params={"afterCursor": after_cursor},
        headers=ndjson_headers,
        timeout=aiohttp.ClientTimeout(total=30),
    ) as resp:
        resp.raise_for_status()
        raw_bytes = await resp.read()
    new_records = []
    for line in raw_bytes.splitlines():
        line = line.strip()
        if not line:
            continue
        obj = nfc(json.loads(line.decode("utf-8")))
        msg = obj.get("message")
        if isinstance(msg, dict):
            if "content" in msg:
                msg["content"] = decode_content(msg["content"])
            if "messageType" in msg:
                msg["messageType"] = nfc(msg["messageType"])
        new_records.append(obj)
    final_records = merge_records(cached_records, new_records)

    with cache_path.open("w", encoding="utf-8") as f:
        json.dump(final_records, f, ensure_ascii=False, indent=2)
    return nfc(
        {
            "artistMemberId": member_id,
            "artistMemberName": artist_member_name,
            "originalName": original_name,
            "profileImageUrl": profile_image_url,
            "lastMessageId": last_message_id,
            "lastMessage": last_msg,
            "records": final_records,
        }
    )


async def fetch_all_channels_data_async(
    access_token: str, artist_id: str = "tripleS"
) -> list[dict]:
    artist_id = nfc(artist_id)
    auth_header = f"Bearer {access_token}"
    ch_headers = {
        **BASE_HEADERS,
        "Accept": "application/json",
        "Authorization": auth_header,
    }
    ndjson_headers = {
        **BASE_HEADERS,
        "Accept": "application/x-ndjson",
        "Authorization": auth_header,
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(
            CHANNELS_URL,
            params={"artistId": artist_id},
            headers=ch_headers,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as ch_resp:
            ch_resp.raise_for_status()
            ch_data = nfc(await ch_resp.json())
        channels = ch_data.get("channels", [])
        tasks = [
            fetch_member_ndjson(session, ch, ndjson_headers)
            for ch in channels
            if ch.get("artistMemberId") is not None
        ]
        return await asyncio.gather(*tasks)


def fetch_all_channels_data(
    access_token: str, artist_id: str = "tripleS"
) -> list[dict]:
    return asyncio.run(fetch_all_channels_data_async(access_token, artist_id))


def fmt_export_timestamp(iso_str: str | None) -> str:
    if not iso_str or not isinstance(iso_str, str):
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00")).astimezone()
        return dt.strftime("%Y/%m/%d %H:%M:%S")
    except ValueError:
        return ""


def build_plain_text_from_records(records: list[dict]) -> str:
    blocks = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        if msg.get("messageType") == "text":
            content = msg.get("content")
            if isinstance(content, str) and content.strip() != "":
                ts = fmt_export_timestamp(msg.get("createdAt"))
                text = nfc(content)
                blocks.append(f"{ts}\n{text}" if ts else text)
    return "\n".join(blocks)


async def _get_valid_token_or_none() -> str | None:
    if not cosmo_auth.exists():
        return None
    try:
        return await cosmo_auth.ensure_fresh_token()
    except Exception:
        return None


def _build_cosmo_headers(token: str, json_body: bool = False) -> dict:
    headers = {
        "Host": "api.cosmo.fans",
        "Accept": "application/json, text/plain, */*",
        "Authorization": f"Bearer {token}",
        "appversion": "2.50.0",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "zh-hant-tw",
        "x-client-trace-id": str(uuid.uuid4()),
        "deviceid": "iPhone12,3",
        "User-Agent": "cosmo/524 CFNetwork/1498.700.2 Darwin/23.6.0",
        "Connection": "keep-alive",
    }
    if json_body:
        headers["Content-Type"] = "application/json"

    auth_file = BASE_DIR / "auth.json"
    if auth_file.exists():
        try:
            raw_auth = json.loads(auth_file.read_text(encoding="utf-8"))
            if isinstance(raw_auth, dict):
                cookie_val = raw_auth.get("cookie") or raw_auth.get("Cookie")
                if cookie_val:
                    headers["Cookie"] = str(cookie_val)
        except Exception:
            pass
    return headers


def _resolve_target_message_id(
    artist_member_id: str, requested_msg_id: str | None
) -> str:
    if requested_msg_id and str(requested_msg_id).strip():
        return nfc(str(requested_msg_id).strip())

    cache_path = get_cache_file(artist_member_id)
    records = load_cached_records(cache_path)
    for rec in reversed(records):
        if not isinstance(rec, dict):
            continue
        msg = rec.get("message")
        if (
            isinstance(msg, dict)
            and msg.get("id") is not None
            and str(msg.get("id")).strip()
        ):
            return nfc(str(msg.get("id")).strip())
    return ""


async def _read_json_body(request: Request) -> dict:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


@app.get("/login")
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html")


@app.post("/api/login/send-otp")
async def api_send_otp(request: Request):
    data = await _read_json_body(request)
    email = nfc(str(data.get("email") or "")).strip()
    try:
        send_otp(email)
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@app.post("/api/login/verify-otp")
async def api_verify_otp(request: Request):
    data = await _read_json_body(request)
    email = nfc(str(data.get("email") or "")).strip()
    code = nfc(str(data.get("code") or "")).strip()
    try:
        verify_otp_and_login(email, code, auth=cosmo_auth)
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@app.get("/")
async def index(request: Request):
    token = await _get_valid_token_or_none()
    if not token:
        return RedirectResponse(url="/login", status_code=302)
    try:
        members_data = await fetch_all_channels_data_async(token, "tripleS")
    except Exception:
        return RedirectResponse(url="/login", status_code=302)
    return templates.TemplateResponse(
        request,
        "cosmo_bubble_chat.html",
        {"members_data": members_data},
    )


@app.get("/export-text")
async def export_text(request: Request):
    token = await _get_valid_token_or_none()
    if not token:
        return RedirectResponse(url="/login", status_code=302)
    member_id_param = nfc(request.query_params.get("artistMemberId", ""))
    members_data = await fetch_all_channels_data_async(token, "tripleS")

    target_member = next(
        (
            m
            for m in members_data
            if str(m.get("artistMemberId")) == str(member_id_param)
        ),
        members_data[0] if members_data else None,
    )

    records = target_member.get("records", []) if target_member else []
    plain_text = build_plain_text_from_records(records)
    label = nfc(
        f"{target_member.get('originalName', '')}_{target_member.get('artistMemberName', '')}".strip(
            "_"
        )
        if target_member
        else "messages"
    )
    filename = f"{label}_text.txt"
    encoded_filename = quote(filename)

    return Response(
        content=plain_text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"; filename*=UTF-8\'\'{encoded_filename}'
            )
        },
    )


@app.get("/api/messages")
async def api_messages(request: Request):
    token = await _get_valid_token_or_none()
    if not token:
        return JSONResponse(
            {
                "ok": False,
                "error": "unauthorized",
                "loginUrl": "/login",
            },
            status_code=401,
        )
    member_id_param = nfc(request.query_params.get("artistMemberId", "")).strip()
    try:
        members_data = await fetch_all_channels_data_async(token, "tripleS")
        if member_id_param:
            filtered = [
                m
                for m in members_data
                if str(m.get("artistMemberId")) == member_id_param
            ]
            return JSONResponse(
                {"ok": True, "members": filtered if filtered else members_data}
            )
        return JSONResponse({"ok": True, "members": members_data})
    except Exception as e:
        return JSONResponse({"ok": False, "error": nfc(str(e))}, status_code=500)


@app.get("/api/reply-count/{artist_member_id}")
async def api_reply_count(artist_member_id: str):
    token = await _get_valid_token_or_none()
    if not token:
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)

    url = REPLY_COUNT_URL_TEMPLATE.format(artist_member_id=artist_member_id)

    async with aiohttp.ClientSession() as session:
        async with session.get(
            url,
            headers=_build_cosmo_headers(token),
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            body = await resp.read()
            return Response(
                content=body,
                status_code=resp.status,
                media_type="application/json; charset=utf-8",
            )


@app.get("/api/stickers")
async def api_stickers():
    token = await _get_valid_token_or_none()
    if not token:
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)

    async with aiohttp.ClientSession() as session:
        async with session.get(
            STICKERS_URL,
            params={"skip": "0", "take": "9999"},
            headers=_build_cosmo_headers(token),
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            body = await resp.read()
            return Response(
                content=body,
                status_code=resp.status,
                media_type="application/json; charset=utf-8",
            )


_CODEPOINT_RE = re.compile(
    r"^(?:\\u|u\+|0x)?\{?([0-9a-fA-F]{4,6})\}?$", re.IGNORECASE
)


def _normalize_payload_content(raw_content: str) -> str:
    s = nfc(str(raw_content or ""))
    if len(s) <= 10:
        m = _CODEPOINT_RE.match(s.strip())
        if m:
            cp = int(m.group(1), 16)
            if 0 <= cp <= 0x10FFFF:
                return nfc(chr(cp))
    return s


@app.post("/api/messages/{artist_member_id}/replies")
async def api_send_reply(artist_member_id: str, request: Request):
    token = await _get_valid_token_or_none()
    if not token:
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)

    data = await _read_json_body(request)
    content = _normalize_payload_content(data.get("content") or "")
    if not content:
        return JSONResponse(
            {"ok": False, "error": "empty content"}, status_code=400
        )

    message_id = _resolve_target_message_id(artist_member_id, data.get("messageId"))
    if not message_id:
        return JSONResponse(
            {"ok": False, "error": "missing target message id"}, status_code=400
        )

    url = SEND_REPLY_URL_TEMPLATE.format(
        artist_member_id=artist_member_id,
        message_id=message_id,
    )
    payload_bytes = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")

    async with aiohttp.ClientSession() as session:
        async with session.post(
            url,
            data=payload_bytes,
            headers=_build_cosmo_headers(token, json_body=True),
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            body = await resp.read()
            return Response(
                content=body,
                status_code=resp.status,
                media_type="application/json; charset=utf-8",
            )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("web:app", host="0.0.0.0", port=9123, reload=False)