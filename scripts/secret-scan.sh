#!/usr/bin/env bash
# コミット直前の機密スキャン。ヒット = exit 1（コミット中止して個別確認）
# 注意: rg はこの環境の bash に無いため POSIX grep -E を使う
# 本スクリプト自身はパターン定義文字列を含むためスキャン対象から除外する
set -u
hits=0
DIFF_PATHS=(-- . ':(exclude)scripts/secret-scan.sh')

KW='api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|passwd|password|authorization:|BEGIN [A-Z ]*PRIVATE KEY'
TOK='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|xox[bpars]-|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}'
FN='\.env(\.|$)|\.pem$|\.pfx$|\.p12$|id_rsa|credential|secret'

if git diff --cached "${DIFF_PATHS[@]}" | grep -Eiq "$KW"; then
  echo "[NG] キーワードヒット（内容）"; git diff --cached "${DIFF_PATHS[@]}" | grep -Ei "$KW" | head -20
  hits=1
fi
if git diff --cached "${DIFF_PATHS[@]}" | grep -Eq "$TOK"; then
  echo "[NG] 既知トークン形式ヒット"; hits=1
fi
if git diff --cached --name-only "${DIFF_PATHS[@]}" | grep -Eiq "$FN"; then
  echo "[NG] 機密様ファイル名ヒット"; git diff --cached --name-only "${DIFF_PATHS[@]}" | grep -Ei "$FN"
  hits=1
fi

if [ "$hits" -eq 0 ]; then echo "[OK] 機密スキャン クリア"; fi
exit $hits
