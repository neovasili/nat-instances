#!/bin/bash

panic() {
  [ -n "$1" ] && echo "[ERROR] $1"
  echo "[ERROR] Setup failed"
  exit 1
}

# Fail fast, check if these commands are going to work
sudo sysctl -w net.ipv4.ip_forward=1 || panic "Failure setting up forwarding"
sudo sysctl -w net.ipv4.conf.eth0.send_redirects=0 || panic "Failure setting up redirects"
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535" || panic "Failure setting up local port range"

sudo iptables -t nat -C POSTROUTING -o eth0 -j MASQUERADE 2> /dev/null ||
  sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE ||
  panic "Failure creating iptables rule"

# Persist all changes
sudo cat >> /etc/sysctl.conf << EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.eth0.send_redirects = 0
net.ipv4.ip_local_port_range = 1024 65535
EOF

sudo cat >> /etc/rc.d/rc.local << EOF
sudo iptables -t nat -C POSTROUTING -o eth0 -j MASQUERADE 2> /dev/null || sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
EOF

# Ensure rc.local run permissions
sudo chmod +x /etc/rc.d/rc.local || panic "Failure establishing rc.local permissions"
