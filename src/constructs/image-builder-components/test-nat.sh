#!/bin/bash

panic() {
  [ -n "$1" ] && echo "[ERROR] $1"
  echo "[ERROR] Test failed"
  exit 1
}

# Check sysctl settings
[[ $(sysctl net.ipv4.ip_forward) == "net.ipv4.ip_forward = 1" ]] ||
  panic "Forwarding mandatory setting is not correct"
[[ $(sysctl net.ipv4.conf.eth0.send_redirects) == "net.ipv4.conf.eth0.send_redirects = 0" ]] ||
  panic "Redirects mandatory setting is not correct"
[[ $(sysctl net.ipv4.ip_local_port_range) == "net.ipv4.ip_local_port_range = 1024	65535" ]] ||
  panic "Local port range mandatory setting is not correct"

# Check iptables settings
sudo iptables -t nat -C POSTROUTING -o eth0 -j MASQUERADE ||
  panic "POSTROUTING mandatory rule does not exists"
