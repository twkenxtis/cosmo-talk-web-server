import asyncio
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import aiofiles
import aiohttp
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

BASE_DIR = Path(__file__).resolve().parent
AUTH_PATH = BASE_DIR / "auth.json"

COSMO_ENDPOINT = "https://api.cosmo.fans"
COSMO_KEY = "aUkaF3wWVltAI1QYVmxsZXfTV6L7mPTxA5+MMkLV9DE="

PRIVY_ENDPOINT = "https://auth.privy.io"
PRIVY_APP_ID = "cm7tt02g000a96m8uislrblbe"
PRIVY_CLIENT = "@privy-io/js-sdk-core:0.60.7.0.1"
USER_AGENT = "okhttp/4.12.0"

REFRESH_BUFFER = 10 * 60 * 60
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _privy_headers() -> dict:
    return {
        "privy-app-id": PRIVY_APP_ID,
        "privy-client": PRIVY_CLIENT,
        "privy-ca-id": str(uuid.uuid4()),
        "Origin": PRIVY_ENDPOINT,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }


NO_SUBSCRIPTION_MSG = "沒有有效的Cosmo Talk訂閱!"


def _extract_api_error_message(raw_body: str) -> str:
    try:
        parsed = json.loads(raw_body)
    except json.JSONDecodeError:
        return raw_body
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            code = err.get("code")
            if code == "USER_NOT_FOUND":
                return NO_SUBSCRIPTION_MSG
            msg = err.get("message")
            if code and msg:
                return f"{code}: {msg}"
            if msg:
                return str(msg)
            if code:
                return str(code)
        if err is not None:
            err_str = str(err)
            if "USER_NOT_FOUND" in err_str:
                return NO_SUBSCRIPTION_MSG
            return err_str
    if "USER_NOT_FOUND" in raw_body:
        return NO_SUBSCRIPTION_MSG
    return raw_body


def _http_post_json(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        detail = _extract_api_error_message(body)
        if detail == NO_SUBSCRIPTION_MSG:
            raise RuntimeError(NO_SUBSCRIPTION_MSG) from None
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


class CosmoAuth:
    """管理 auth.json 的讀取、刷新與持久化"""

    def __init__(self, auth_path: Path = AUTH_PATH, buffer: int = REFRESH_BUFFER):
        self.auth_path = Path(auth_path)
        self.buffer = buffer

    @staticmethod
    def encrypt(plaintext: str, key_base64: str = COSMO_KEY) -> str:
        key = base64.b64decode(key_base64)
        iv = os.urandom(16)

        padder = padding.PKCS7(algorithms.AES.block_size).padder()
        padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()

        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()

        return base64.b64encode(iv + ciphertext).decode("utf-8")

    @staticmethod
    def extract_credentials(obj) -> dict:
        def find(node, camel, snake):
            if isinstance(node, dict):
                if camel in node and node[camel]:
                    return node[camel]
                if snake in node and node[snake]:
                    return node[snake]
                for value in node.values():
                    found = find(value, camel, snake)
                    if found is not None:
                        return found
            elif isinstance(node, list):
                for value in node:
                    found = find(value, camel, snake)
                    if found is not None:
                        return found
            return None

        access = find(obj, "accessToken", "access_token")
        refresh_token = find(obj, "refreshToken", "refresh_token")
        if not access or not refresh_token:
            raise ValueError("could not find accessToken/refreshToken in response")
        return {"accessToken": access, "refreshToken": refresh_token}

    def exists(self) -> bool:
        return self.auth_path.exists() and self.auth_path.is_file()

    async def load_tokens(self) -> dict:
        if not self.exists():
            raise FileNotFoundError(f"{self.auth_path} not found")
        async with aiofiles.open(self.auth_path, "r", encoding="utf-8") as f:
            content = await f.read()
        data = json.loads(content)
        return self.extract_credentials(data)

    async def save_tokens(self, creds_or_resp: dict) -> dict:
        creds = self.extract_credentials(creds_or_resp)
        self.auth_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.auth_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        async with aiofiles.open(fd, "w", encoding="utf-8") as f:
            await f.write(json.dumps(creds, indent=2, ensure_ascii=False) + "\n")
        return creds

    @staticmethod
    def decode_exp(token: str) -> int:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return int(payload["exp"])

    def is_expired(self, token: str) -> bool:
        try:
            return self.decode_exp(token) - time.time() <= self.buffer
        except Exception:
            return True

    @staticmethod
    async def refresh(refresh_token: str) -> dict:
        encrypted = CosmoAuth.encrypt(
            json.dumps({"refreshToken": refresh_token}), COSMO_KEY
        )
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{COSMO_ENDPOINT}/bff/v3/users/refresh-access-token",
                data=encrypted.encode("utf-8"),
                headers={
                    "Content-Type": "text/plain",
                    "x-cosmo-encrypted": "1",
                    "User-Agent": USER_AGENT,
                },
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                body = await resp.json()
        return CosmoAuth.extract_credentials(body)

    async def ensure_fresh_token(self) -> str:
        creds = await self.load_tokens()
        access = creds.get("accessToken")
        if access and not self.is_expired(access):
            return access
        refresh_token = creds.get("refreshToken")
        if not refresh_token:
            raise RuntimeError("auth.json has no refreshToken")
        refreshed = await self.refresh(refresh_token)
        await self.save_tokens(refreshed)
        return refreshed["accessToken"]


def send_otp(email: str) -> None:
    email = email.strip()
    if not EMAIL_RE.match(email):
        raise ValueError(f"Invalid email format: {email}")
    _http_post_json(
        f"{PRIVY_ENDPOINT}/api/v1/passwordless/init",
        {"email": email},
        _privy_headers(),
    )


def verify_otp_and_login(email: str, code: str, auth: CosmoAuth | None = None) -> dict:
    email = email.strip()
    code = code.strip()
    if not EMAIL_RE.match(email):
        raise ValueError(f"Invalid email format: {email}")
    if not code:
        raise ValueError("OTP code is required")
    if len(code) > 6:
        raise ValueError("OTP code must be at most 6 digits")
    privy_resp = _http_post_json(
        f"{PRIVY_ENDPOINT}/api/v1/passwordless/authenticate",
        {"email": email, "code": code, "mode": "login-or-sign-up"},
        _privy_headers(),
    )
    privy_token = privy_resp.get("token") or privy_resp.get("privy_access_token")
    if not privy_token:
        raise RuntimeError("Privy did not return an access token")
    encrypted_payload = CosmoAuth.encrypt(json.dumps({"token": privy_token}), COSMO_KEY)
    req = urllib.request.Request(
        f"{COSMO_ENDPOINT}/bff/v3/users/login-by-privy",
        data=encrypted_payload.encode("utf-8"),
        headers={
            "Content-Type": "text/plain",
            "x-cosmo-encrypted": "1",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            account = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        detail = _extract_api_error_message(body)
        if detail == NO_SUBSCRIPTION_MSG:
            raise RuntimeError(NO_SUBSCRIPTION_MSG) from None
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None
    target_auth = auth or CosmoAuth()
    creds = target_auth.extract_credentials(account)
    target_auth.auth_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target_auth.auth_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(creds, indent=2, ensure_ascii=False) + "\n")
    return account


def _prompt(label: str) -> str:
    print(label, end="", file=sys.stderr, flush=True)
    return input().strip()


def cli_main() -> None:
    email = sys.argv[1].strip() if len(sys.argv) > 1 else _prompt("email: ")
    try:
        send_otp(email)
    except Exception as e:
        print(f"Error requesting code: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"a login code was sent to {email}", file=sys.stderr)
    code = _prompt("code: ")

    try:
        account = verify_otp_and_login(email, code)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"saved tokens to {AUTH_PATH}", file=sys.stderr)
    print(json.dumps(account, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        token = asyncio.run(CosmoAuth().ensure_fresh_token())
        print(token)
    else:
        cli_main()