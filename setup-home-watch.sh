#!/bin/sh
# 在 OpenWrt（RAX3000Z 增強版 / XR30）上安裝 webos-vibehack 的 Home 鍵監控
# 用法：sh setup-home-watch.sh <電視IP>
# 例如：sh setup-home-watch.sh 192.168.1.50
set -e

TV="$1"
DIR=/root/webos-vibehack
RAW=https://raw.githubusercontent.com/jammy912/webos-vibehack/main

if [ -z "$TV" ]; then
  echo "用法：sh $0 <電視IP>"
  exit 1
fi

echo "== 1/5 安裝 Python =="
if command -v apk >/dev/null 2>&1; then
  apk update
  apk add python3 python3-pip
else
  opkg update
  opkg install python3 python3-pip
fi

echo "== 2/5 安裝 websockets =="
if ! python3 -c "import websockets" 2>/dev/null; then
  if command -v apk >/dev/null 2>&1; then
    apk add python3-websockets 2>/dev/null || true
  else
    opkg install python3-websockets 2>/dev/null || true
  fi
fi
if ! python3 -c "import websockets" 2>/dev/null; then
  pip3 install websockets || pip3 install --break-system-packages websockets
fi
python3 -c "import websockets; print('websockets', websockets.__version__)"

echo "== 3/5 下載監控程式 =="
mkdir -p "$DIR"
wget -q -O "$DIR/lgtv.py" "$RAW/lgtv.py"
wget -q -O "$DIR/home-watch.py" "$RAW/home-watch.py"
chmod +x "$DIR/home-watch.py"

echo "== 4/5 與電視配對 =="
if [ -f "$DIR/.lgtv-key.json" ] && grep -q "\"$TV\"" "$DIR/.lgtv-key.json"; then
  echo "已有 $TV 的配對金鑰，略過。"
else
  # 電視待機或剛開機時 3001 不會回應，先等它起來，避免直接噴 TimeoutError
  n=0
  until python3 -c "import socket,sys; socket.create_connection((sys.argv[1], 3001), 3).close()" "$TV" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -ge 12 ]; then
      echo "重試 12 次仍連不到 $TV:3001：電視沒開、在待機，或 IP 不對。開好電視後重跑本腳本。"
      exit 1
    fi
    echo "電視（$TV:3001）還沒回應，請打開電視；5 秒後重試（$n/12）..."
    sleep 5
  done
  echo "請在電視上接受「允許此裝置？」的提示（60 秒內）..."
  cd "$DIR"
  python3 - "$TV" <<'EOF'
import asyncio, sys
import lgtv

async def main(host):
    ws = await lgtv.session(host)
    await ws.close()
    print("配對成功，金鑰已存到 .lgtv-key.json")

try:
    asyncio.run(main(sys.argv[1]))
except Exception as e:
    print(f"配對失敗：{type(e).__name__} {e}")
    print("請確認電視開著、有按「允許」，然後重跑本腳本。")
    sys.exit(1)
EOF
fi

echo "== 5/5 設定開機自動執行 =="
cat > /etc/init.d/home-watch <<EOF
#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1

start_service() {
  procd_open_instance
  procd_set_param command /usr/bin/python3 $DIR/home-watch.py $TV
  procd_set_param respawn
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_close_instance
}
EOF
chmod +x /etc/init.d/home-watch
/etc/init.d/home-watch enable
/etc/init.d/home-watch restart

echo
echo "完成。按電視遙控器的 Home 測試，記錄可用以下指令查看："
echo "  logread -f | grep -i home"
echo "提醒：請在 LuCI → 網路 → DHCP 和 DNS → 靜態位址分配，把電視固定在 $TV。"
