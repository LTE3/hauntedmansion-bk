#!/usr/bin/env python3
"""Block a commit that carries a live credential.

Why this exists
---------------
On 2026-09-02 a scan of a PUBLIC repo's working tree found eleven files
holding a live Stripe secret key, a live Supabase management token, or a
Supabase service_role JWT. None of them were tracked, so nothing had
leaked. That was luck. The .gitignore was a list of exact filenames and
every one of those eleven had a name nobody had thought to add yet.

A filename blocklist cannot win this. The thing that has to be checked is
the content of what is about to be committed, every time, without anyone
remembering to. That is a pre-commit hook, which is what this is.

Usage
-----
    secretscan.py            scan the staged change (what a hook runs)
    secretscan.py --all      scan every tracked file in the worktree
    secretscan.py --files A B ...   scan specific paths

Exit 0 clean, exit 1 on a finding. Findings print the file, the line and
the KIND of credential - never the credential itself, because a hook that
echoes the secret into a terminal, a CI log and a scrollback buffer has
made the exposure worse than it found it.
"""

import base64
import json
import re
import subprocess
import sys

# Each pattern matches a credential shape specific enough that a hit is a
# credential and not prose about one. Anything looser produces false
# positives, and a gate that cries wolf gets bypassed with --no-verify
# within a week, which is the same as having no gate.
PATTERNS = [
    ("Stripe live secret key",      re.compile(r"sk_live_[A-Za-z0-9]{20,}")),
    ("Stripe live restricted key",  re.compile(r"rk_live_[A-Za-z0-9]{20,}")),
    ("Stripe test secret key",      re.compile(r"sk_test_[A-Za-z0-9]{20,}")),
    ("Supabase management token",   re.compile(r"sbp_[0-9a-f]{40}")),
    ("GitHub PAT (classic)",        re.compile(r"ghp_[A-Za-z0-9]{36}")),
    ("GitHub PAT (fine-grained)",   re.compile(r"github_pat_[A-Za-z0-9_]{40,}")),
    ("GitHub OAuth token",          re.compile(r"gho_[A-Za-z0-9]{36}")),
    ("Google API key",              re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("Slack bot token",             re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Resend API key",              re.compile(r"re_[A-Za-z0-9]{24,}")),
    ("SendGrid API key",            re.compile(r"SG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}")),
    ("AWS access key id",           re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private key block",           re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("Twilio account SID",          re.compile(r"AC[0-9a-f]{32}")),
]

# A JWT cannot be matched on shape alone, because the anon key is a JWT
# too and belongs in client-side code by design - it is published on
# purpose and the database's row-level security is what actually guards
# the data. The role claim inside is the whole difference: anon is public,
# service_role bypasses every policy and is a total compromise of the
# project. So decode rather than pattern-match, and judge on the claim.
JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.(eyJ[A-Za-z0-9_\-]{8,})\.[A-Za-z0-9_\-]{8,}")
BANNED_ROLES = {"service_role", "supabase_admin"}


def jwt_role(payload_b64):
    """Return the role claim of a JWT payload, or None if it will not decode."""
    pad = "=" * (-len(payload_b64) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload_b64 + pad)).get("role")
    except Exception:
        return None


def scan(name, text):
    out = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for kind, rx in PATTERNS:
            if rx.search(line):
                out.append((name, lineno, kind))
        for m in JWT.finditer(line):
            role = jwt_role(m.group(1))
            if role in BANNED_ROLES:
                out.append((name, lineno, "Supabase %s JWT" % role))
    return out


def git(*args):
    return subprocess.run(["git"] + list(args), capture_output=True).stdout


def staged_files():
    out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    return [p for p in out.decode("utf-8", "replace").split("\0") if p]


def blob(path, staged):
    """Read the version being committed, not the version on disk.

    These differ whenever a file was staged and then edited, and it is the
    staged one that is about to become public.
    """
    if staged:
        r = subprocess.run(["git", "show", ":" + path], capture_output=True)
        return r.stdout if r.returncode == 0 else b""
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return b""


def main():
    argv = sys.argv[1:]
    staged = True
    if "--all" in argv:
        staged = False
        files = [p for p in git("ls-files", "-z").decode("utf-8", "replace").split("\0") if p]
    elif "--files" in argv:
        staged = False
        files = argv[argv.index("--files") + 1:]
    else:
        files = staged_files()

    findings = []
    for path in files:
        data = blob(path, staged)
        # A NUL in the first 8KB means binary. Images and fonts do not hold
        # pasted API keys, and decoding them produces noise, not findings.
        if b"\0" in data[:8192]:
            continue
        findings += scan(path, data.decode("utf-8", "replace"))

    if not findings:
        return 0

    print("\nBLOCKED: live credentials in %s\n" % ("the staged change" if staged else "the scanned files"))
    for path, lineno, kind in findings:
        print("  %s:%d  %s" % (path, lineno, kind))
    print("""
The value itself is deliberately not printed.

To fix: take the credential out of the file and read it at runtime from
an environment variable or an ignored file, then ROTATE it - once a
secret has been written to a file it should be treated as compromised
whether or not the commit went through.

--no-verify skips this check. If you are reaching for it, the reason is
almost always that rotating is inconvenient right now, which is the same
reason that ends with a key on GitHub.""")
    return 1


if __name__ == "__main__":
    sys.exit(main())
