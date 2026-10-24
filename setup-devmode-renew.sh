#!/bin/sh
# 在 OpenWrt（XR30）上設定 LG Developer Mode 自動續期
# 原理：SSH 進電視（prisoner@TV:9922）讀出 /var/luna/preferences/devmode_enabled 的 token，
#       再呼叫 https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=<token>
#
# 事前準備：把 Windows 上 ares 產生的私鑰複製到路由器
#   （在 Windows PowerShell 執行）scp -O $HOME\.ssh\lgtv_webos root@192.168.1.1:/root/webos-vibehack/
#
# 用法：sh setup-devmode-renew.sh <電視IP> <Passphrase>
# 例如：sh setup-devmode-renew.sh 192.168.1.104 49A4B0
set -e

TV="$1"
PASS="$2"
DIR=/root/webos-vibehack
SRC_KEY="$DIR/lgtv_webos"
KEY="$DIR/devmode_key"
RENEW="$DIR/renew-devmode.sh"

if [ -z "$TV" ] || [ -z "$PASS" ]; then
  echo "用法：sh $0 <電視IP> <Passphrase>"
  exit 1
fi
if [ ! -f "$SRC_KEY" ] && [ ! -f "$KEY" ]; then
  echo "找不到 $SRC_KEY。請先從 Windows 複製私鑰："
  echo '  scp -O $HOME\.ssh\lgtv_webos root@<路由器IP>:/root/webos-vibehack/'
  exit 1
fi

echo "== 1/4 安裝 OpenSSH 用戶端 =="
if command -v apk >/dev/null 2>&1; then
  apk update
  apk add openssh-client openssh-keygen ca-bundle
else
  opkg update
  opkg install openssh-client openssh-keygen ca-bundle
fi

echo "== 2/4 解開私鑰（之後排程不需要再輸入 Passphrase） =="
if [ ! -f "$KEY" ]; then
  cp "$SRC_KEY" "$KEY"
  chmod 600 "$KEY"
  if ! ssh-keygen -p -f "$KEY" -P "$PASS" -N "" >/dev/null; then
    rm -f "$KEY"
    echo "解開失敗：Passphrase 不對，或私鑰不是 Developer Mode 的那一把。"
    exit 1
  fi
  rm -f "$SRC_KEY"
  echo "已存成 $KEY（權限 600）"
else
  echo "$KEY 已存在，略過。"
fi

echo "== 3/4 建立續期腳本 =="
cat > "$RENEW" <<EOF
#!/bin/sh
# 每小時由 cron 呼叫；成功一次後 20 小時內不再重複續期
TV="$TV"
KEY="$KEY"
STAMP=/tmp/devmode-renew.ok
URL="https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken="
EOF
cat >> "$RENEW" <<'EOF'
log() { logger -t devmode-renew "$*"; echo "$*"; }

if [ "$1" != "--force" ] && [ -f "$STAMP" ] && \
   [ $(( $(date +%s) - $(cat "$STAMP") )) -lt 72000 ]; then
  exit 0
fi

SSH="ssh -p 9922 -i $KEY -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa -o LogLevel=ERROR"

TOKEN=$($SSH prisoner@"$TV" "cat /var/luna/preferences/devmode_enabled" 2>/dev/null | tr -d '\r\n ')
if [ -z "$TOKEN" ]; then
  # 有些韌體的 prisoner 帳號只接受互動式 shell
  TOKEN=$(echo "cat /var/luna/preferences/devmode_enabled; exit" | \
          $SSH prisoner@"$TV" "/bin/sh -i" 2>/dev/null | tr -d '\r' | grep -E '^[0-9A-Za-z]{16,}$' | tail -n 1)
fi
if [ -z "$TOKEN" ]; then
  log "讀不到 token（電視關機、待機，或 Developer Mode 已關閉），下次再試"
  exit 1
fi

RESP=$(wget -qO- "$URL$TOKEN" 2>&1) || {
  log "呼叫 LG 續期網址失敗：$RESP"
  exit 1
}
date +%s > "$STAMP"
log "續期成功（token ...${TOKEN#${TOKEN%????}}）；LG 回應：$(echo "$RESP" | head -c 200)"
EOF
chmod +x "$RENEW"

echo "== 4/4 設定每小時排程並先測試一次 =="
CRON=/etc/crontabs/root
touch "$CRON"
grep -v "renew-devmode.sh" "$CRON" > "$CRON.tmp" || true
echo "23 * * * * $RENEW" >> "$CRON.tmp"
mv "$CRON.tmp" "$CRON"
/etc/init.d/cron enable
/etc/init.d/cron restart

echo
if "$RENEW" --force; then
  echo "完成。之後每小時檢查一次，每天最多續期一次。"
  echo "到電視的 Developer Mode App 確認 Login Session 是否回到 999h。"
else
  echo "排程已設定，但這次測試沒有成功。請確認電視開著、Developer Mode 啟用中，"
  echo "再手動執行：$RENEW --force"
fi
echo "查看紀錄：logread | grep devmode-renew"
