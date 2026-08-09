#!/usr/bin/env bash
# コミット直前の機密スキャン。ヒット = exit 1（コミット中止して個別確認）
set -u
hits=0

if git diff --cached | rg -iq "api[_-]?key|secret|token|passwd|password|authorization:|BEGIN [A-Z ]*PRIVATE KEY"; then
  echo "[NG] キーワードヒット（内容）"; git diff --cached | rg -i "api[_-]?key|secret|token|passwd|password|authorization:|BEGIN [A-Z ]*PRIVATE KEY" | head -20
  hits=1
fi
if git diff --cached | rg -q "AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|xox[bpars]-|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_\-]{35}"; then
  echo "[NG] 既知トークン形式ヒット"; hits=1
fi
if git diff --cached --name-only | rg -iq "\.env(\.|$)|\.pem$|\.pfx$|\.p12$|id_rsa|credential|secret"; then
  echo "[NG] 機密様ファイル名ヒット"; git diff --cached --name-only | rg -i "\.env(\.|$)|\.pem$|\.pfx$|\.p12$|id_rsa|credential|secret"
  hits=1
fi

if [ "$hits" -eq 0 ]; then echo "[OK] 機密スキャン クリア"; fi
exit $hits
