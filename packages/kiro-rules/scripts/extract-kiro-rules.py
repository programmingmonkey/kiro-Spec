#!/usr/bin/env python3
"""Re-extract Kiro's 4 spec validators from the extension bundle.

Authority: /Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js
The bundle's validate*Format functions are the only authoritative source for the
Markdown format — kiro.dev has never specified it. `--emit-bundle-meta` also
reports the bundle's *identity*, so a consumer of the `kiro-rules` package can
tell which Kiro build the table replicates.

This script NEVER writes a file; it only prints. That is load-bearing: the
regression in `plugins/dsh-spec/test/boundaries.test.mjs` ("re-running the
extractor leaves the tree unchanged") holds because there is no write path here,
not because of a rule someone has to remember.

Usage:
  python3 extract-kiro-rules.py                     # human-readable extraction
  python3 extract-kiro-rules.py --json              # the same, as JSON
  python3 extract-kiro-rules.py --emit-bundle-meta  # the KIRO_BUNDLE block

`--emit-bundle-meta` prints a ready-to-paste `KIRO_BUNDLE` for
`packages/kiro-rules/lib/kiro-rules.js`, so none of the four values is
hand-written. `extractedAt` is re-used from the committed block whenever
`version` and `sha256` are both unchanged, which is what makes "re-run, paste,
`git diff` is empty" actually true — the alternative (stamping today's date on
every run) would turn that regression into noise nobody reads.
"""
import hashlib
import json
import os
import re
import sys
from datetime import date

# 规范路径 —— 「bundle 只有一个家」。
# 🔴 这一行**必须保持字面量形式**：`scripts/kiro-bundle-root.mjs` 用正则
# `^BUNDLE\s*=\s*"([^"]+)"` 现读它，好让 JS 侧不必再抄一份绝对路径。改成表达式会让
# 那边当场抛（它不返回猜测值），而不是悄悄降级成另一条过期路径。
BUNDLE = "/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js"

# 前门钥匙（2026-09-13）：非作者主机 —— CI、Cowork 的 Linux VM —— 用 KIRO_EXTENSION_JS 指定。
# 在这之前，`plugins/dsh-spec/test/boundaries.test.mjs` 那两条**带 STOP 门**的围栏交叉验证
# 在任何别的机器上都只能 skip：门槛是绿的，但只在一台机器上跑得起来。
BUNDLE_PATH = os.environ.get("KIRO_EXTENSION_JS") or BUNDLE
# `<ext>/dist/extension.js` -> `<ext>`. The extension manifest is the authority
# for the version, NOT Kiro.app's own: this machine has Kiro.app 1.0.437 and
# kiro.kiro-agent 1.0.794, and the rules come from the extension.
EXTENSION_DIR = BUNDLE_PATH.rsplit("/dist/", 1)[0]
EXTENSION_PKG = os.path.join(EXTENSION_DIR, "package.json")
KIRO_RULES_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib", "kiro-rules.js"
)
#: 四个校验器的**友好名**。minified 名**不写死**——见 resolve_targets()。
FRIENDLY_NAMES = (
    "validateRequirementsFormat",
    "validateDesignFormat",
    "validateTasksFormat",
    "validateBugfixFormat",
)

#: `c(FN,"validateXxxFormat")` —— bundle 自带的具名注册行，是「这个 minified 名是哪个校验器」
#: 的**唯一权威**。与 `kiro-validators.mjs` 的 NAME_MAP_RE 同一手法。
ANCHOR_RE = re.compile(r'c\((\w+),"(validate\w+Format)"\)')


def resolve_targets(src):
    """友好名 → minified 名，**从 bundle 现读**。

    🔴 这里曾经是一张写死的表（`validateDesignFormat: "Cxd"` 等）。2026-09-16 的
    Kiro 1.0.794 → 1.1.28 升版证明了那样做的后果，而且不是「红」，是**静默错答**：

      · `Txd` / `bxd` / `Ixd` 的定义随升版消失 → `extract_fn` 返回 None（可见，但看不出原因）；
      · `Cxd` 的定义**仍在**，只是被复用成了另一个函数（实测注册为
        `isNetworkConnectivityError`）→ `extract_fn` 按名字命中它、切出函数体、贴上
        `validateDesignFormat` 的标签打印。**取错了函数、贴对了标签、不报任何错。**

    写死 minified 名的代价因此不是维护成本，是**真判定被悄悄替换成别的代码**——与
    `kiro-validators.mjs` 里那句「静默少注入一个名字会让判定悄悄失真」是同一类失败。
    改从锚点推导后：升版重新混淆会自动跟随；锚点缺失或歧义则**响亮抛**。
    """
    found = {}
    for minified, friendly in ANCHOR_RE.findall(src):
        if friendly not in FRIENDLY_NAMES:
            continue  # 例如 validateLinkHeaderFormat——不在本次提取面内
        if friendly in found and found[friendly] != minified:
            raise SystemExit(
                f"bundle 里 {friendly} 注册了多于一个 minified 名："
                f"{found[friendly]} 与 {minified} —— 锚点有歧义，人工复核后再提取"
            )
        found[friendly] = minified
    missing = [n for n in FRIENDLY_NAMES if n not in found]
    if missing:
        raise SystemExit(
            f"bundle 里没有注册这些校验器：{missing} —— 锚点已失效（c(FN,\"…Format\") 的形状变了），"
            "人工复核后再提取；**不得**回退到写死的 minified 名"
        )
    return {name: found[name] for name in FRIENDLY_NAMES}

# The committed `KIRO_BUNDLE` block, so a re-run can tell whether the identity
# actually changed. Parsing the file we are about to hand-paste into is the only
# way to keep `extractedAt` stable without a second source of truth.
META_BLOCK = re.compile(r"export const KIRO_BUNDLE = Object\.freeze\(\{(?P<body>.*?)\n\}\)", re.S)
META_STRING_FIELD = re.compile(r"(\w+):\s*'([^']*)'")


def extract_fn(src, fn_name):
    m = re.search(r"function\s+" + fn_name + r"\s*\(([^)]*)\)\s*\{", src)
    if not m:
        return None
    i = m.end() - 1
    depth = 0
    j = i
    while j < len(src):
        c = src[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[m.start():j + 1]
        j += 1
    return None


def live_bundle_meta():
    """The bundle identity as measured on THIS machine. Never guessed: a missing
    bundle or manifest raises (and the caller prints a traceback + exit 1) rather
    than emitting empty fields a test would then have to treat as valid."""
    with open(BUNDLE_PATH, "rb") as f:
        raw = f.read()
    with open(EXTENSION_PKG, encoding="utf-8") as f:
        version = json.load(f)["version"]
    return {
        "version": version,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def committed_bundle_meta():
    """The `KIRO_BUNDLE` already on disk, or {} when there is none yet."""
    try:
        src = open(KIRO_RULES_JS, encoding="utf-8").read()
    except OSError:
        return {}
    m = META_BLOCK.search(src)
    return dict(META_STRING_FIELD.findall(m.group("body"))) if m else {}


def emit_bundle_meta():
    live = live_bundle_meta()
    prev = committed_bundle_meta()
    # bytes alone is NOT part of the identity test: the bundle was rebuilt on
    # 2026-09-11 (12,978,019 -> 12,978,260 bytes) with the same extension version
    # and the same 41 rule codes. sha256 is the field that decides.
    unchanged = (
        prev.get("version") == live["version"] and prev.get("sha256") == live["sha256"]
    )
    extracted_at = prev.get("extractedAt") if unchanged else None
    # Exactly the block, no banner: the paste target in `lib/kiro-rules.js` is the
    # `export const KIRO_BUNDLE = Object.freeze({…})` region (it carries its own
    # explanatory comment above it). Emitting anything else would make "re-run,
    # paste, `git diff` is empty" an act of interpretation rather than a diff.
    print("export const KIRO_BUNDLE = Object.freeze({")
    print(f"  version: '{live['version']}',")
    print(f"  bytes: {live['bytes']},")
    print(f"  sha256: '{live['sha256']}',")
    print(f"  extractedAt: '{extracted_at or date.today().isoformat()}',")
    print("})")


def main():
    if "--emit-bundle-meta" in sys.argv:
        emit_bundle_meta()
        return

    src = open(BUNDLE_PATH, encoding="utf-8", errors="replace").read()
    out = {"bundle": BUNDLE_PATH, "bundle_bytes": len(src.encode("utf-8")), "functions": {}}
    for friendly, minified in resolve_targets(src).items():
        body = extract_fn(src, minified)
        if body is None:
            # 名字来自锚点却取不到函数体 —— 锚点与函数定义脱节了，不许静默印 None。
            raise SystemExit(
                f"锚点说 {friendly} 是 {minified}，但 bundle 里找不到 `function {minified}(` "
                "—— 人工复核后再提取"
            )
        out["functions"][friendly] = {"minified": minified, "body": body}

    codes = sorted(set(re.findall(
        r'rule:"((?:requirements|design|tasks|bugfix)/[A-Za-z0-9-]+)"', src)))
    out["rule_codes"] = codes
    out["rule_code_count"] = len(codes)
    by_area = {}
    for c in codes:
        by_area.setdefault(c.split("/")[0], []).append(c)
    out["by_area"] = {k: {"count": len(v), "codes": v} for k, v in sorted(by_area.items())}

    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    print(f"bundle: {out['bundle']}  ({out['bundle_bytes']} bytes)")
    print(f"rule codes: {out['rule_code_count']}")
    for area, info in out["by_area"].items():
        print(f"  {area}: {info['count']}")
    # Flat, machine-readable list on its own marker line, so a test can assert
    # the plugin's emitted code set against the bundle without parsing prose.
    print()
    print("RULE_CODES_BEGIN")
    for code in out["rule_codes"]:
        print(f"  {code}")
    print("RULE_CODES_END")
    print()
    for friendly, info in out["functions"].items():
        print(f"===== {friendly} (minified {info['minified']}) =====")
        print(info["body"])
        print()


if __name__ == "__main__":
    main()
