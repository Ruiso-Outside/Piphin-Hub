// Motor de entrada do Piphin Macro: ganchos globais de teclado/mouse (WH_*_LL) e SendInput.
// Não é um .exe: o próprio PowerShell do Windows compila este código em memória (Add-Type),
// então nada é baixado e o Controle Inteligente de Aplicativos não bloqueia.
// Protocolo: uma linha por comando no stdin, campos separados por TAB; eventos saem no stdout.
// C# 5 (compilador do .NET Framework): sem $"", ?. ou out var.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Piphin {

public static class MacroEngine {
  // ------------------------------------------------------------------ Win32
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);

  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4, KEYEVENTF_SCANCODE = 8;
  const uint MOUSEEVENTF_MOVE = 1, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000,
             MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
  // marca das entradas geradas por nós (dwExtraInfo): o gancho as reconhece e não dispara atalhos com elas
  static readonly IntPtr MARK = new IntPtr(0x50495048);

  // ------------------------------------------------------------------ estado
  static StreamWriter stdout;
  static readonly BlockingCollection<string> outbox = new BlockingCollection<string>();
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static readonly object sync = new object();
  static HookProc kbProc, msProc; // referências vivas para o GC não coletar os delegates
  static IntPtr kbHook, msHook;
  static uint hookThread;

  static volatile bool monitor, monitorMoves, hotkeysPaused;
  static double lastMoveEmit;
  static int modState; // 1 Ctrl, 2 Alt, 4 Shift, 8 Win (só teclas físicas)
  static int panicVk, panicMods;

  class Hotkey { public string id; public int vk, mods; public bool swallow, down; public string[] procs; }
  static readonly Dictionary<string, Hotkey> hotkeys = new Dictionary<string, Hotkey>();
  static readonly Dictionary<string, Runner> runners = new Dictionary<string, Runner>();

  static double Now() { return clock.Elapsed.TotalMilliseconds; }
  static string F(double v) { return v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture); }
  static void Emit(string line) { outbox.Add(line); }

  // ------------------------------------------------------------------ entrada
  public static void Main() {
    if (IntPtr.Size != 8) { Console.WriteLine("err\tO motor precisa do PowerShell de 64 bits"); return; }
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    timeBeginPeriod(1);
    stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    var writer = new Thread(delegate () {
      foreach (var line in outbox.GetConsumingEnumerable()) { try { stdout.WriteLine(line); } catch { Environment.Exit(0); } }
    });
    writer.IsBackground = true; writer.Start();

    var hooks = new Thread(HookLoop);
    hooks.IsBackground = true; hooks.Priority = ThreadPriority.Highest; hooks.Start();

    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string cmd;
    while ((cmd = stdin.ReadLine()) != null) {
      try { if (!Command(cmd.Split('\t'))) break; }
      catch (Exception e) { Emit("err\t" + e.Message.Replace('\t', ' ').Replace('\n', ' ')); }
    }
    // stdin fechou (o Hub saiu): solta tudo o que estiver pressionado e encerra
    StopAll("quit");
    if (hookThread != 0) PostThreadMessage(hookThread, 0x12, IntPtr.Zero, IntPtr.Zero);
    Thread.Sleep(50);
    Environment.Exit(0);
  }

  static bool Command(string[] a) {
    switch (a[0]) {
      case "ping": Emit("pong"); break;
      case "quit": return false;
      case "mon": monitor = a[1] == "1"; monitorMoves = a.Length > 2 && a[2] == "1"; break;
      case "hkpause": hotkeysPaused = a[1] == "1"; break;
      case "panic": panicVk = int.Parse(a[1]); panicMods = a.Length > 2 ? int.Parse(a[2]) : 0; break;
      case "hk": {
        var h = new Hotkey { id = a[1], vk = int.Parse(a[2]), mods = int.Parse(a[3]), swallow = a[4] == "1" };
        var procs = new List<string>();
        if (a.Length > 5) foreach (var p in a[5].Split(',')) { var s = p.Trim().ToLowerInvariant(); if (s.EndsWith(".exe")) s = s.Substring(0, s.Length - 4); if (s.Length > 0) procs.Add(s); }
        h.procs = procs.ToArray();
        lock (sync) {
          Hotkey old;
          if (hotkeys.TryGetValue(h.id, out old) && old.vk == h.vk) h.down = old.down; // mantém o estado se o atalho é o mesmo
          hotkeys[h.id] = h;
        }
        break;
      }
      case "hkdel": lock (sync) hotkeys.Remove(a[1]); break;
      case "hkclear": lock (sync) hotkeys.Clear(); break;
      case "run": {
        // run  id  repetições(0 = sem fim)  variação%  passos
        string id = a[1];
        var r = new Runner(id, int.Parse(a[2]), double.Parse(a[3], System.Globalization.CultureInfo.InvariantCulture) / 100.0, Step.Parse(a.Length > 4 ? a[4] : ""));
        lock (sync) {
          Runner old;
          if (runners.TryGetValue(id, out old)) old.Stop("restart");
          runners[id] = r;
        }
        r.Start();
        break;
      }
      case "stop": { Runner r; lock (sync) runners.TryGetValue(a[1], out r); if (r != null) r.Stop("stop"); break; }
      case "stopall": StopAll("stop"); break;
      case "pos": { POINT p; GetCursorPos(out p); Emit("pos\t" + p.x + "\t" + p.y); break; }
      case "pix": {
        POINT p; GetCursorPos(out p);
        int x = a.Length > 2 && a[1] != "" ? int.Parse(a[1]) : p.x, y = a.Length > 2 && a[2] != "" ? int.Parse(a[2]) : p.y;
        Emit("pix\t" + x + "\t" + y + "\t" + Pixel(x, y).ToString("x6"));
        break;
      }
      case "fg": Emit("fg\t" + ForegroundProcess()); break;
      case "screen": Emit("screen\t" + GetSystemMetrics(76) + "\t" + GetSystemMetrics(77) + "\t" + GetSystemMetrics(78) + "\t" + GetSystemMetrics(79)); break;
    }
    return true;
  }

  static void StopAll(string reason) {
    List<Runner> list;
    lock (sync) list = new List<Runner>(runners.Values);
    foreach (var r in list) r.Stop(reason);
  }

  // ------------------------------------------------------------------ ganchos globais
  static void HookLoop() {
    hookThread = GetCurrentThreadId();
    kbProc = KeyboardHook; msProc = MouseHook;
    IntPtr mod = GetModuleHandle(null);
    kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, mod, 0);
    msHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, mod, 0);
    if (kbHook == IntPtr.Zero || msHook == IntPtr.Zero) Emit("err\tNão foi possível instalar os ganchos de teclado/mouse (" + Marshal.GetLastWin32Error() + ")");
    Emit("ready\t" + GetSystemMetrics(76) + "\t" + GetSystemMetrics(77) + "\t" + GetSystemMetrics(78) + "\t" + GetSystemMetrics(79));
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    UnhookWindowsHookEx(kbHook); UnhookWindowsHookEx(msHook);
  }

  static int ModBit(int vk) {
    switch (vk) {
      case 0x11: case 0xA2: case 0xA3: return 1;
      case 0x12: case 0xA4: case 0xA5: return 2;
      case 0x10: case 0xA0: case 0xA1: return 4;
      case 0x5B: case 0x5C: return 8;
    }
    return 0;
  }

  static IntPtr KeyboardHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
      int msg = w.ToInt32();
      bool down = msg == 0x100 || msg == 0x104;
      bool ours = k.extra == MARK;
      bool injected = (k.flags & 0x10) != 0;
      int vk = (int)k.vkCode;
      if (monitor)
        Emit("k\t" + (down ? "d" : "u") + "\t" + vk + "\t" + k.scanCode + "\t" + ((k.flags & 1) != 0 ? 1 : 0) + "\t" + (ours ? 2 : injected ? 1 : 0) + "\t" + F(Now()));
      if (!ours) {
        int bit = ModBit(vk);
        if (bit != 0) { if (down) modState |= bit; else modState &= ~bit; }
        if (Trigger(vk, down)) return new IntPtr(1);
      }
    }
    return CallNextHookEx(kbHook, code, w, l);
  }

  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
      int msg = w.ToInt32();
      bool ours = m.extra == MARK;
      bool injected = (m.flags & 1) != 0;
      string kind = null; int btn = 0; int delta = 0;
      switch (msg) {
        case 0x200: kind = "mv"; break;
        case 0x201: kind = "d"; btn = 1; break;
        case 0x202: kind = "u"; btn = 1; break;
        case 0x204: kind = "d"; btn = 2; break;
        case 0x205: kind = "u"; btn = 2; break;
        case 0x207: kind = "d"; btn = 4; break;
        case 0x208: kind = "u"; btn = 4; break;
        case 0x20B: kind = "d"; btn = ((m.mouseData >> 16) & 0xFFFF) == 1 ? 5 : 6; break;
        case 0x20C: kind = "u"; btn = ((m.mouseData >> 16) & 0xFFFF) == 1 ? 5 : 6; break;
        case 0x20A: kind = "wh"; delta = (short)((m.mouseData >> 16) & 0xFFFF); break;
        case 0x20E: kind = "hw"; delta = (short)((m.mouseData >> 16) & 0xFFFF); break;
      }
      if (kind != null && monitor) {
        double t = Now();
        if (kind != "mv" || (monitorMoves && t - lastMoveEmit >= 8)) {
          if (kind == "mv") lastMoveEmit = t;
          Emit("m\t" + kind + "\t" + m.pt.x + "\t" + m.pt.y + "\t" + (btn != 0 ? btn : delta) + "\t" + (ours ? 2 : injected ? 1 : 0) + "\t" + F(t));
        }
      }
      // botões do mouse também podem ser atalhos (botões laterais, do meio...)
      if (!ours && btn != 0 && Trigger(btn, kind == "d")) return new IntPtr(1);
    }
    return CallNextHookEx(msHook, code, w, l);
  }

  // Devolve true se a tecla deve ser bloqueada (não chega ao jogo)
  static bool Trigger(int vk, bool down) {
    if (panicVk != 0 && vk == panicVk && down && (modState & panicMods) == panicMods) {
      StopAll("panic");
      Emit("panic");
      return false;
    }
    bool swallow = false;
    lock (sync) {
      if (down) {
        Hotkey best = null; int bestBits = -1;
        foreach (var h in hotkeys.Values) {
          if (h.vk != vk || (modState & h.mods) != h.mods) continue;
          if (h.down) { swallow |= h.swallow; best = null; bestBits = 99; break; } // repetição automática do teclado
          int bits = Bits(h.mods);
          if (bits > bestBits) { best = h; bestBits = bits; }
        }
        if (best != null && !hotkeysPaused && ProcessMatches(best.procs)) {
          best.down = true;
          Emit("hd\t" + best.id);
          swallow = best.swallow;
        }
      } else {
        foreach (var h in hotkeys.Values) {
          if (h.vk == vk && h.down) { h.down = false; Emit("hu\t" + h.id); swallow |= h.swallow; }
        }
      }
    }
    return swallow;
  }

  static int Bits(int v) { int c = 0; while (v != 0) { c += v & 1; v >>= 1; } return c; }

  static IntPtr fgHwnd; static string fgName = "";
  static string ForegroundProcess() {
    IntPtr h = GetForegroundWindow();
    if (h == fgHwnd) return fgName;
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
    fgHwnd = h; fgName = name;
    return name;
  }
  static bool ProcessMatches(string[] procs) {
    if (procs == null || procs.Length == 0) return true;
    string fg = ForegroundProcess();
    foreach (var p in procs) if (p == fg) return true;
    return false;
  }

  static uint Pixel(int x, int y) {
    IntPtr dc = GetDC(IntPtr.Zero);
    uint c = GetPixel(dc, x, y);
    ReleaseDC(IntPtr.Zero, dc);
    // COLORREF é 0x00BBGGRR
    return ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
  }

  // ------------------------------------------------------------------ envio de entradas
  static readonly int INPUT_SIZE = Marshal.SizeOf(typeof(INPUT));

  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, INPUT_SIZE); }

  public static void Key(int vk, bool down) {
    if (vk >= 1 && vk <= 6 && vk != 3) { MouseButton(vk, down); return; }
    // por scancode: funciona também em jogos que leem DirectInput/Raw Input
    uint sc = MapVirtualKey((uint)vk, 4); // MAPVK_VK_TO_VSC_EX
    var i = new INPUT { type = 1 };
    i.ki.wVk = (ushort)vk;
    i.ki.extra = MARK;
    if (sc != 0) {
      i.ki.wScan = (ushort)(sc & 0xFF);
      i.ki.dwFlags = KEYEVENTF_SCANCODE;
      if ((sc & 0xFF00) == 0xE000 || (sc & 0xFF00) == 0xE100) i.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }
    if (!down) i.ki.dwFlags |= KEYEVENTF_KEYUP;
    Send(i);
  }

  public static void Unicode(char c, bool down) {
    var i = new INPUT { type = 1 };
    i.ki.wScan = c;
    i.ki.dwFlags = KEYEVENTF_UNICODE | (down ? 0 : KEYEVENTF_KEYUP);
    i.ki.extra = MARK;
    Send(i);
  }

  // vk dos botões: 1 esquerdo, 2 direito, 4 meio, 5 lateral 1 (voltar), 6 lateral 2 (avançar)
  public static void MouseButton(int b, bool down) {
    var i = new INPUT { type = 0 };
    i.mi.extra = MARK;
    switch (b) {
      case 1: i.mi.dwFlags = down ? 0x2u : 0x4u; break;
      case 2: i.mi.dwFlags = down ? 0x8u : 0x10u; break;
      case 4: i.mi.dwFlags = down ? 0x20u : 0x40u; break;
      case 5: i.mi.dwFlags = down ? 0x80u : 0x100u; i.mi.mouseData = 1; break;
      case 6: i.mi.dwFlags = down ? 0x80u : 0x100u; i.mi.mouseData = 2; break;
      default: return;
    }
    Send(i);
  }

  public static void MoveAbsolute(double x, double y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var i = new INPUT { type = 0 };
    i.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    i.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    i.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    i.mi.extra = MARK;
    Send(i);
  }

  public static void MoveRelative(int dx, int dy) {
    if (dx == 0 && dy == 0) return;
    var i = new INPUT { type = 0 };
    i.mi.dx = dx; i.mi.dy = dy;
    i.mi.dwFlags = MOUSEEVENTF_MOVE;
    i.mi.extra = MARK;
    Send(i);
  }

  public static void Wheel(int delta, bool horizontal) {
    var i = new INPUT { type = 0 };
    i.mi.mouseData = (uint)delta;
    i.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    i.mi.extra = MARK;
    Send(i);
  }

  public static POINT CursorPos() { POINT p; GetCursorPos(out p); return p; }
  public static uint PixelAt(int x, int y) { return Pixel(x, y); }

  // ------------------------------------------------------------------ passos de uma macro
  public class Step {
    public string op; public double[] n; public string s; public int jump;
    // "kd,65;w,50,80;ku,65" -> lista de passos
    public static List<Step> Parse(string text) {
      var list = new List<Step>();
      var stack = new Stack<int>();
      foreach (var part in text.Split(';')) {
        if (part.Length == 0) continue;
        var f = part.Split(',');
        var st = new Step { op = f[0], n = new double[f.Length - 1] };
        for (int i = 1; i < f.Length; i++) {
          double v;
          if (double.TryParse(f[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v)) st.n[i - 1] = v;
          else st.s = f[i];
        }
        if (st.op == "t" && f.Length > 1) st.s = Encoding.UTF8.GetString(Convert.FromBase64String(f[1]));
        if (st.op == "rs") stack.Push(list.Count);
        if (st.op == "re" && stack.Count > 0) { int start = stack.Pop(); st.jump = start; list[start].jump = list.Count; }
        list.Add(st);
      }
      return list;
    }
    public double N(int i, double def) { return i < n.Length ? n[i] : def; }
  }

  public class Runner {
    readonly string id; readonly int repeat; readonly double jitter; readonly List<Step> steps;
    volatile bool stopped; string reason = "done";
    readonly HashSet<int> held = new HashSet<int>();
    readonly Random rnd = new Random(Guid.NewGuid().GetHashCode());
    Thread thread;

    public Runner(string id, int repeat, double jitter, List<Step> steps) { this.id = id; this.repeat = repeat; this.jitter = jitter; this.steps = steps; }

    public void Start() {
      thread = new Thread(Body);
      thread.IsBackground = true;
      thread.Priority = ThreadPriority.AboveNormal;
      thread.Start();
    }
    public void Stop(string why) { if (!stopped) { reason = why; stopped = true; } }

    void Body() {
      int loops = 0;
      try {
        if (steps.Count == 0) return;
        while (!stopped && (repeat <= 0 || loops < repeat)) {
          loops++;
          Emit("loop\t" + id + "\t" + loops);
          var counters = new Dictionary<int, int>();
          for (int pc = 0; pc < steps.Count && !stopped; pc++) {
            var s = steps[pc];
            if (s.op == "rs") { counters[pc] = 0; continue; }
            if (s.op == "re") {
              int start = s.jump, c;
              counters.TryGetValue(start, out c); c++; counters[start] = c;
              double times = steps[start].N(0, 1);
              if (times <= 0 || c < times) pc = start; // 0 = repete o bloco sem fim
              continue;
            }
            Exec(s);
          }
          if (repeat <= 0 && steps.Count > 0 && !HasWait()) Wait(1); // laço sem espera não trava a CPU
        }
      } catch (Exception e) {
        reason = "error"; Emit("err\t" + id + ": " + e.Message);
      } finally {
        // segurança: nunca deixa tecla ou botão preso
        foreach (var vk in held) Key(vk, false);
        held.Clear();
        lock (sync) { Runner cur; if (runners.TryGetValue(id, out cur) && cur == this) runners.Remove(id); }
        Emit("end\t" + id + "\t" + reason + "\t" + loops);
      }
    }

    bool hasWait = false, checkedWait = false;
    bool HasWait() {
      if (!checkedWait) { checkedWait = true; foreach (var s in steps) if (s.op == "w" || s.op == "wc" || s.op == "kp" || s.op == "mc") hasWait = true; }
      return hasWait;
    }

    double Vary(double ms) { return jitter <= 0 ? ms : Math.Max(0, ms * (1 + (rnd.NextDouble() * 2 - 1) * jitter)); }

    // Espera precisa: dorme enquanto falta bastante e gira no final (timeBeginPeriod(1) já está ligado)
    void Wait(double ms) {
      if (ms <= 0) return;
      double end = Now() + ms;
      while (!stopped) {
        double left = end - Now();
        if (left <= 0) break;
        if (left > 2.5) Thread.Sleep((int)Math.Min(left - 2, 15));
        else Thread.SpinWait(200);
      }
    }

    void Down(int vk) { Key(vk, true); held.Add(vk); }
    void Up(int vk) { Key(vk, false); held.Remove(vk); }

    void Exec(Step s) {
      switch (s.op) {
        case "kd": Down((int)s.N(0, 0)); break;
        case "ku": Up((int)s.N(0, 0)); break;
        case "kp": { int vk = (int)s.N(0, 0); Down(vk); Wait(Vary(s.N(1, 30))); Up(vk); break; }
        case "w": {
          double a = s.N(0, 0), b = s.N(1, a);
          double ms = b > a ? a + rnd.NextDouble() * (b - a) : a;
          Wait(Vary(ms));
          break;
        }
        case "md": Down((int)s.N(0, 1)); break;
        case "mu": Up((int)s.N(0, 1)); break;
        case "mc": {
          int b = (int)s.N(0, 1); int count = Math.Max(1, (int)s.N(2, 1));
          for (int i = 0; i < count && !stopped; i++) {
            if (i > 0) Wait(Vary(s.N(1, 30)));
            Down(b); Wait(Vary(s.N(1, 30))); Up(b);
          }
          break;
        }
        case "ma": MoveTo(s.N(0, 0), s.N(1, 0), Vary(s.N(2, 0))); break;
        case "mr": MoveBy(s.N(0, 0), s.N(1, 0), Vary(s.N(2, 0))); break;
        case "wh": Wheel((int)s.N(0, 120), false); break;
        case "hw": Wheel((int)s.N(0, 120), true); break;
        case "t": {
          double gap = s.N(1, 15);
          foreach (char c in s.s ?? "") {
            if (stopped) break;
            if (c == '\n') { Key(0x0D, true); Key(0x0D, false); }
            else if (c != '\r') { Unicode(c, true); Unicode(c, false); }
            Wait(Vary(gap));
          }
          break;
        }
        case "wc": {
          // espera a cor do pixel (x, y) ficar igual a rrggbb (tolerância por canal); tempo limite em ms (0 = sem limite)
          int x = (int)s.N(0, 0), y = (int)s.N(1, 0);
          uint want = Convert.ToUInt32(s.s ?? "000000", 16);
          int tol = (int)s.N(3, 10); double timeout = s.N(4, 0);
          bool not = s.N(5, 0) != 0;
          double end = Now() + timeout;
          while (!stopped) {
            bool match = Close(Pixel(x, y), want, tol);
            if (match != not) break;
            if (timeout > 0 && Now() >= end) break;
            Wait(15);
          }
          break;
        }
      }
    }

    static bool Close(uint a, uint b, int tol) {
      for (int sh = 0; sh <= 16; sh += 8) if (Math.Abs((int)((a >> sh) & 0xFF) - (int)((b >> sh) & 0xFF)) > tol) return false;
      return true;
    }

    // Movimento suave em linha (ou curva leve quando há variação), um passo a cada ~4 ms
    void MoveTo(double x, double y, double dur) {
      if (dur < 4) { MoveAbsolute(x, y); return; }
      POINT p = CursorPos();
      double sx = p.x, sy = p.y;
      double dx = x - sx, dy = y - sy;
      double len = Math.Sqrt(dx * dx + dy * dy);
      double bend = jitter > 0 ? (rnd.NextDouble() * 2 - 1) * Math.Min(80, len * 0.15) : 0;
      double nx = len > 0 ? -dy / len : 0, ny = len > 0 ? dx / len : 0;
      double start = Now();
      while (!stopped) {
        double t = Math.Min(1, (Now() - start) / dur);
        double e = t * t * (3 - 2 * t);
        double arc = 4 * t * (1 - t) * bend;
        MoveAbsolute(sx + dx * e + nx * arc, sy + dy * e + ny * arc);
        if (t >= 1) break;
        Wait(4);
      }
    }

    // Movimento relativo (jogos em primeira pessoa, câmera): divide em pedaços e acumula as frações
    void MoveBy(double dx, double dy, double dur) {
      if (dur < 4) { MoveRelative((int)Math.Round(dx), (int)Math.Round(dy)); return; }
      double start = Now(), doneX = 0, doneY = 0;
      while (!stopped) {
        double t = Math.Min(1, (Now() - start) / dur);
        int mx = (int)Math.Round(dx * t - doneX), my = (int)Math.Round(dy * t - doneY);
        MoveRelative(mx, my); doneX += mx; doneY += my;
        if (t >= 1) break;
        Wait(4);
      }
    }
  }
}
}
