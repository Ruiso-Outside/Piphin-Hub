"""Print da tela pelo portal do GNOME/KDE (Wayland), usado pela Central quando o X11 nao enxerga a tela.
Uso: python3 portal-shot.py [interativo 0|1] [segundos]  ->  "<codigo> <uri>"  (codigo 0 = ok)"""
import sys, random
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
token = "piphin%d" % random.randint(0, 1 << 30)
sender = bus.get_unique_name()[1:].replace(".", "_")
path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
loop = GLib.MainLoop(); out = {}
def on_resp(conn, snd, obj, iface, sig, params):
    code, res = params.unpack(); out["code"] = code; out["uri"] = res.get("uri", ""); loop.quit()
bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_resp)
bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
              GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", len(sys.argv) > 1 and sys.argv[1] == "1")})), None, Gio.DBusCallFlags.NONE, -1, None)
GLib.timeout_add_seconds(int(sys.argv[2]) if len(sys.argv) > 2 else 120, lambda: (out.setdefault("code", 99), loop.quit()))
loop.run()
print(out.get("code"), out.get("uri", ""))
