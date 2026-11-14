"""Собирает BOT_EMPLOYEES (JSON одной строкой) из employees.yml и секретов GitHub
(отдельных или строк KEY=VALUE в секрете ENV_FILE).

Использование: ALL_SECRETS='<toJSON(secrets)>' python3 scripts/employees.py employees.yml
Печатает JSON в stdout; предупреждения — в формате GitHub Actions (::warning::).
Код выхода 1, если не собрался ни один сотрудник.
"""
import json
import os
import re
import sys

import yaml


def warn(msg):
    print(f"::warning::{msg}", file=sys.stderr)


def parse_env_file(text):
    """Строки KEY=VALUE из секрета ENV_FILE; # — комментарии, кавычки вокруг значения убираются."""
    result = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:  # пустая строка не затирает отдельный секрет
            result[key] = value
    return result


def main(path):
    raw = json.loads(os.environ.get("ALL_SECRETS") or "{}")
    # Секреты можно задать по одному или все сразу в одном секрете ENV_FILE; ENV_FILE главнее
    # (там обычно самые свежие токены), отдельный секрет — запасной вариант.
    secrets = {**{k: v for k, v in raw.items() if v}, **parse_env_file(raw.get("ENV_FILE"))}
    env_keys = sorted(parse_env_file(raw.get("ENV_FILE")))
    print(f"ENV_FILE: {', '.join(env_keys) or 'пусто'}", file=sys.stderr)  # только имена, без значений
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        warn("employees.yml: ожидается список сотрудников вида «имя: настройки»")
        return 1

    result = []
    for name, cfg in data.items():
        cfg = cfg or {}
        prefix = re.sub(r"[^A-Z0-9]", "_", str(name).upper())
        tg_secret = cfg.get("telegram_token_secret") or f"{prefix}_TELEGRAM_TOKEN"
        rt_secret = cfg.get("routine_token_secret") or f"{prefix}_ROUTINE_TOKEN"
        url_secret = cfg.get("routine_url_secret")
        routine = secrets.get(url_secret) if url_secret else cfg.get("routine")
        missing = [s for s in (tg_secret, rt_secret) if not secrets.get(s)]
        if not routine:
            missing.append(url_secret or "routine (в employees.yml)")
        if missing:
            warn(f"сотрудник {name} пропущен: не заданы {', '.join(missing)}")
            continue
        chats = cfg.get("chats") or []
        if not chats:
            warn(f"сотрудник {name}: chats пуст — бот будет отвечать только на /id")
        result.append(
            {
                "name": str(name),
                "telegramToken": secrets[tg_secret],
                "routineToken": secrets[rt_secret],
                "routineFireUrl": str(routine),
                "chatIds": [int(c) for c in chats],
                "userIds": [int(u) for u in cfg.get("users") or []],
                "about": str(cfg.get("about") or ""),
                "names": [str(n) for n in (cfg.get("names") or [])],
            }
        )

    # Маскируем все значения секретов и токены сотрудников, чтобы они не попали в лог Actions.
    masks = {v for v in secrets.values() if v and len(v) >= 6}
    for e in result:
        masks.update([e["telegramToken"], e["routineToken"], e["routineFireUrl"]])
    for m in sorted(masks):
        for part in str(m).splitlines():
            if part.strip():
                print(f"::add-mask::{part.strip()}")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    # Общие настройки бота (расшифровка голосовых) — в окружение следующих шагов Actions.
    gh_env = os.environ.get("GITHUB_ENV")
    extra = {k: secrets[k] for k in ("STT_API_URL", "STT_API_KEY", "STT_MODEL", "STT_LANGUAGE") if secrets.get(k)}
    if gh_env and extra:
        with open(gh_env, "a", encoding="utf-8") as f:
            for k, v in extra.items():
                f.write(f"{k}={v}\n")
    print(f"Голосовые: {'включены' if extra.get('STT_API_URL') and extra.get('STT_API_KEY') else 'выключены (нет STT_API_URL / STT_API_KEY)'}", file=sys.stderr)
    print(f"Сотрудников собрано: {len(result)} ({', '.join(e['name'] for e in result)})", file=sys.stderr)
    return 0 if result else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "employees.yml"))
