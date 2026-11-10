#!/usr/bin/env python3
import argparse
import os
import platform
import re
import shutil
import subprocess
import sys

# Пропускна здатність памʼяті, ГБ/с (специфікації виробників).
GPU_BANDWIDTH = [
    ("RTX 5090", 1792), ("RTX 5080", 960), ("RTX 5070 Ti", 896), ("RTX 5070", 672), ("RTX 5060 Ti", 448), ("RTX 5060", 448),
    ("RTX 4090", 1008), ("RTX 4080 SUPER", 736), ("RTX 4080", 717), ("RTX 4070 Ti SUPER", 672), ("RTX 4070 Ti", 504),
    ("RTX 4070 SUPER", 504), ("RTX 4070", 504), ("RTX 4060 Ti", 288), ("RTX 4060", 272),
    ("RTX 3090 Ti", 1008), ("RTX 3090", 936), ("RTX 3080 Ti", 912), ("RTX 3080", 760), ("RTX 3070 Ti", 608), ("RTX 3070", 448),
    ("RTX 3060 Ti", 448), ("RTX 3060", 360), ("RTX 3050", 224),
    ("RTX 2080 Ti", 616), ("RTX 2080", 448), ("RTX 2070", 448), ("RTX 2060", 336),
    ("GTX 1660", 192), ("GTX 1650", 128), ("GTX 1080 Ti", 484), ("GTX 1080", 320), ("GTX 1070", 256), ("GTX 1060", 192),
    ("Tesla T4", 320), ("T4", 320), ("A100", 1555), ("H100", 3350), ("L4", 300),
]
APPLE_BANDWIDTH = [
    ("M4 Max", 546), ("M4 Pro", 273), ("M4", 120), ("M3 Max", 400), ("M3 Pro", 150), ("M3 Ultra", 819), ("M3", 100),
    ("M2 Ultra", 800), ("M2 Max", 400), ("M2 Pro", 200), ("M2", 100),
    ("M1 Ultra", 800), ("M1 Max", 400), ("M1 Pro", 200), ("M1", 68),
]

QUANTS = [("Q2_K", 3.35), ("Q3_K_M", 3.9), ("Q4_K_M", 4.85), ("Q5_K_M", 5.7), ("Q6_K", 6.56), ("Q8_0", 8.5), ("F16", 16.0)]

MODELS = [
    ("Qwen3-0.6B", 0.6, 0.6, 28, 8, 128),
    ("Qwen3-1.7B", 1.7, 1.7, 28, 8, 128),
    ("Qwen3-4B", 4.0, 4.0, 36, 8, 128),
    ("Qwen3-8B", 8.2, 8.2, 36, 8, 128),
    ("Qwen3-14B", 14.8, 14.8, 40, 8, 128),
    ("Qwen3-30B-A3B (MoE)", 30.5, 3.3, 48, 4, 128),
    ("Qwen3-32B", 32.8, 32.8, 64, 8, 128),
]

def weights_gb(params_b, bits):
    return params_b * bits / 8

def kv_cache_gb(layers, kv_heads, head_dim, context, bytes_per_value=2):
    return 2 * layers * kv_heads * head_dim * bytes_per_value * context / 1e9

def overhead_gb(weights):
    return 0.5 + 0.1 * weights

def speed_ceiling(bandwidth_gbs, active_params_b, bits):
    read_gb = weights_gb(active_params_b, bits)
    return bandwidth_gbs / read_gb if read_gb > 0 else float("inf")

def estimate(model, bits, context):
    name, params, active, layers, kv_heads, head_dim = model
    w = weights_gb(params, bits)
    kv = kv_cache_gb(layers, kv_heads, head_dim, context)
    return {"name": name, "weights": w, "kv": kv, "overhead": overhead_gb(w), "total": w + kv + overhead_gb(w), "active": active}

def run(cmd, timeout=8):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=isinstance(cmd, str))
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""

def powershell(expr):
    return run(["powershell", "-NoProfile", "-Command", expr])

def detect_cpu():
    system = platform.system()
    if system == "Darwin":
        return run(["sysctl", "-n", "machdep.cpu.brand_string"]), "sysctl machdep.cpu.brand_string"
    if system == "Linux":
        try:
            with open("/proc/cpuinfo", encoding="utf-8") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip(), "/proc/cpuinfo"
        except OSError:
            pass
    if system == "Windows":
        name = powershell("(Get-CimInstance Win32_Processor).Name")
        if name:
            return name, "PowerShell Get-CimInstance Win32_Processor"
    return platform.processor() or platform.machine(), "platform.processor()"

def detect_ram_gb():
    try:
        import psutil
        return psutil.virtual_memory().total / 2**30, "psutil.virtual_memory().total"
    except ImportError:
        pass
    system = platform.system()
    if system == "Linux":
        try:
            with open("/proc/meminfo", encoding="utf-8") as f:
                kb = int(re.search(r"MemTotal:\s+(\d+)", f.read()).group(1))
            return kb / 2**20, "/proc/meminfo (MemTotal)"
        except (OSError, AttributeError):
            pass
    if system == "Darwin":
        value = run(["sysctl", "-n", "hw.memsize"])
        if value.isdigit():
            return int(value) / 2**30, "sysctl hw.memsize"
    if system == "Windows":
        value = powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")
        if value.isdigit():
            return int(value) / 2**30, "PowerShell Win32_ComputerSystem"
    return None, "не вдалося визначити"


def detect_gpu():
    if shutil.which("nvidia-smi"):
        out = run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        if out:
            name, mem = [x.strip() for x in out.splitlines()[0].split(",")]
            return name, float(mem) / 1024, "nvidia-smi --query-gpu=name,memory.total", False
    if platform.system() == "Darwin":
        out = run(["system_profiler", "SPDisplaysDataType"], timeout=15)
        match = re.search(r"Chipset Model:\s*(.+)", out)
        if match:
            return match.group(1).strip(), None, "system_profiler SPDisplaysDataType", "Apple" in match.group(1)
    if platform.system() == "Windows":
        out = powershell("(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name")
        if out:
            return out, None, "PowerShell Win32_VideoController (VRAM введіть через --vram-gb)", False
    if platform.system() == "Linux":
        out = run("lspci 2>/dev/null | grep -i -E 'vga|3d'")
        if out:
            return out.splitlines()[0].split(": ", 1)[-1], None, "lspci (VRAM введіть через --vram-gb)", False
    return None, None, "відеокарту не виявлено", False


def lookup_bandwidth(gpu_name):
    if not gpu_name:
        return None
    upper = gpu_name.upper()
    for key, value in GPU_BANDWIDTH:
        if key.upper() in upper:
            return value
    for key, value in APPLE_BANDWIDTH:
        if re.search(rf"\b{re.escape(key.upper())}\b", upper):
            return value
    return None

def build_report(args):
    cpu, cpu_src = detect_cpu()
    ram, ram_src = (args.ram_gb, "задано вручну (--ram-gb)") if args.ram_gb else detect_ram_gb()
    gpu, vram, gpu_src, unified = detect_gpu()
    if args.gpu:
        gpu, gpu_src = args.gpu, "задано вручну (--gpu)"
        unified = "APPLE" in args.gpu.upper() or bool(re.match(r"\s*M\d", args.gpu, re.I))
    vram_src = gpu_src
    if args.vram_gb:
        vram, vram_src = args.vram_gb, "задано вручну (--vram-gb)"

    if unified and vram is None:
        vram = ram

    bandwidth, bw_src = None, ""
    if args.bandwidth:
        bandwidth, bw_src = args.bandwidth, "задано вручну (--bandwidth, зі специфікації)"
    else:
        found = lookup_bandwidth(gpu)
        if found:
            bandwidth, bw_src = found, "довідкова таблиця за назвою пристрою — звірте зі специфікацією виробника"

    if vram and not unified:
        pool, pool_name = vram * 0.92, f"VRAM {vram:.1f} ГБ × 0,92"
    elif unified:
        pool, pool_name = (vram or ram) * 0.70, f"уніфікована памʼять {(vram or ram):.0f} ГБ × 0,70 (частина потрібна системі)"
    else:
        pool, pool_name = (ram or 0) * 0.70, f"RAM {ram:.1f} ГБ × 0,70 (частина потрібна системі)"
        if not bandwidth:
            bw_src = "невідомо: для CPU це канали × МТ/с × 8 байт (напр. DDR4-3200 ×2 канали = 51,2 ГБ/с) — вкажіть --bandwidth"

    lines = ["| Параметр | Значення | Звідки взято |", "|---|---|---|"]
    lines.append(f"| Система | {platform.platform()} | platform.platform() |")
    lines.append(f"| Процесор | {cpu or 'невідомо'} | {cpu_src}; логічних ядер: {os.cpu_count()} (os.cpu_count()) |")
    lines.append(f"| RAM | {f'{ram:.1f} ГБ' if ram else 'невідомо'} | {ram_src} |")
    lines.append(f"| Відеокарта | {gpu or 'немає / не виявлена'} | {gpu_src} |")
    if gpu:
        vram_text = f"{vram:.1f} ГБ" + (" (спільна з RAM)" if unified else "") if vram else "введіть через --vram-gb"
        lines.append(f"| VRAM | {vram_text} | {'уніфікована памʼять Apple Silicon = RAM' if unified else vram_src} |")
    lines.append(f"| Пропускна здатність памʼяті для ваг | {f'{bandwidth} ГБ/с' if bandwidth else 'невідомо'} | {bw_src or 'невідомо — вкажіть --bandwidth'} |")
    lines.append(f"| Памʼять, доступна під модель | {pool:.1f} ГБ | {pool_name} |")

    out = ["## Залізо", "", *lines, "", f"## Бюджет (контекст {args.context} токенів, KV-кеш у fp16)", ""]
    out += ["Формули: ваги = параметри × біт/8; KV = 2 × шарів × KV-голів × розмір голови × 2 Б × контекст; запас = 0,5 ГБ + 10 % ваг;",
            "стеля швидкості = пропускна здатність / обсяг ваг, що читаються за токен (для MoE — лише активні параметри).", ""]
    header = "| Модель | Квантизація | Ваги, ГБ | KV, ГБ | Запас, ГБ | Разом, ГБ | Вміщається | Стеля, ток/с | Реалістично (≈60 %) |"
    out += [header, "|---|---|---|---|---|---|---|---|---|"]
    best = None
    for model in MODELS:
        for quant, bits in QUANTS:
            e = estimate(model, bits, args.context)
            fits = e["total"] <= pool
            ceiling = speed_ceiling(bandwidth, e["active"], bits) if bandwidth else None
            comfortable = e["total"] <= pool * 0.9  # лишаємо запас, щоб система не почала свопитись
            if comfortable and quant in ("Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0") and (best is None or model[1] > best[0][1] or (model[1] == best[0][1] and bits > best[1])):
                best = (model, bits, quant, e, ceiling)
            out.append(f"| {e['name']} | {quant} | {e['weights']:.1f} | {e['kv']:.2f} | {e['overhead']:.1f} | {e['total']:.1f} | "
                       f"{'так' if fits else 'ні'} | {f'{ceiling:.0f}' if ceiling else '—'} | {f'{ceiling * 0.6:.0f}' if ceiling else '—'} |")
    out.append("")
    if best:
        model, bits, quant, e, ceiling = best
        speed = f"; стеля ≈ {ceiling:.0f} ток/с, реалістично ≈ {ceiling * 0.6:.0f}" if ceiling else ""
        out.append(f"Найбільша модель серед Q4–Q8, що вміщається із запасом 10 %: **{e['name']} {quant}** — {e['total']:.1f} ГБ із {pool:.1f}{speed}.")
        out.append("Це верхня межа можливого, а не рекомендація: для застосунку часто краще взяти меншу й швидшу модель — обґрунтуйте вибір у звіті.")
    else:
        out.append("Жодна з моделей Q4–Q8 не вміщається: оберіть меншу модель або нижчу квантизацію (Q3/Q2 помітно гірші за якістю).")
    return "\n".join(out)

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--context", type=int, default=4096, help="довжина контексту для KV-кешу (за замовчуванням 4096)")
    parser.add_argument("--bandwidth", type=float, help="пропускна здатність памʼяті ваг, ГБ/с (зі специфікації)")
    parser.add_argument("--ram-gb", type=float, help="виправити визначений обсяг RAM")
    parser.add_argument("--vram-gb", type=float, help="виправити/задати VRAM")
    parser.add_argument("--gpu", help="виправити/задати назву відеокарти")
    parser.add_argument("--markdown", action="store_true", help="друкувати лише Markdown (без службових повідомлень)")
    parser.add_argument("--out", help="додатково зберегти звіт у цей файл (кодування UTF-8)")
    args = parser.parse_args()
    if not sys.stdout.isatty():
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError, OSError):
                pass
    report = build_report(args)
    print(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(report + "\n")
        print(f"\nЗвіт збережено: {args.out}", file=sys.stderr)
    if not args.markdown:
        print("\n(Скопіюйте таблиці у звіт 1.8. Значення з позначкою «довідкова таблиця» звірте зі специфікацією — це вимога завдання.)", file=sys.stderr)

if __name__ == "__main__":
    main()
