#!/bin/sh
# Derleme baglamindaki .git'ten calisan commit'i okur ve basar; okuyamazsa hicbir sey basmaz.
# Derlemeye commit vermeyen platformlar (NineDeploy gibi) icin: .dockerignore .git'ten yalniz HEAD ve
# ref'leri alir, nesneler imaja girmez. .git hic yoksa (zip indirme) bos doner, derleme bozulmaz.
s=""; g=${1:-/tmp/baglam}/.git
if [ -f "$g/HEAD" ]; then
  h=$(cat "$g/HEAD")
  case "$h" in
    "ref: "*) r=${h#ref: }
      if [ -f "$g/$r" ]; then s=$(cat "$g/$r")
      elif [ -f "$g/packed-refs" ]; then s=$(grep " $r\$" "$g/packed-refs" | cut -d" " -f1); fi ;;
    *) s=$h ;;
  esac
fi
echo "$s" | grep -Eq '^[0-9a-f]{40}$' && echo "$s" || true
