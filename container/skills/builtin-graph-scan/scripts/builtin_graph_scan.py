#!/usr/bin/env python3
"""
builtin-graph-scan — 零第三方依赖的仓库知识图谱构建脚本。

与 OctoDeck repo-knowledge 模块共用的约定：
  - 输入：仓库根目录（--repo）、输出目录（--output-dir）
  - 输出：chunks.json / edges.json / stats.json / summary.md
  - 退出码：0 成功，非 0 失败
  - stdout：只打印一行 JSON {"ok": ..., "chunks": N, "edges": M, ...}，stderr 留做日志
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable


# ────────────────────────────── 常量 ──────────────────────────────────────────

DEFAULT_EXCLUDE_DIRS = {
    '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
    '.turbo', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv',
    '.idea', '.vscode', '.mypy_cache', '.pytest_cache', '.tox', '.eggs',
    'CVS', '.svn', '.hg',
}

SENSITIVE_DIR_NAMES = {'.ssh', '.aws', '.gcloud', '.azure', '.kube', '.terraform'}
SENSITIVE_FILE_NAMES = {
    '.env', '.envrc', '.npmrc', '.netrc', '.pypirc',
    'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa',
    'credentials.json', 'client_secret.json',
}
SENSITIVE_FILE_EXT = {'.pem', '.key', '.p12', '.pfx', '.crt', '.cer',
                     '.sqlite', '.sqlite3', '.db', '.db3', '.sql'}

TEXT_EXTS = {
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.mts',
    '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.awk', '.sed', '.make',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.css', '.scss', '.less', '.sass', '.html', '.vue', '.svelte',
    '.sql', '.graphql', '.gql', '.proto', '.dockerfile', '.gradle', '.xml',
    '.md', '.mdx', '.rst', '.txt',
}

LANG_BY_EXT = {
    '.ts': 'typescript', '.tsx': 'typescript-react',
    '.js': 'javascript', '.jsx': 'javascript-react',
    '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.scala': 'scala', '.c': 'c', '.cc': 'c++', '.cpp': 'c++',
    '.h': 'c-header', '.hpp': 'c++-header',
    '.cs': 'csharp', '.php': 'php', '.rb': 'ruby', '.swift': 'swift',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'html', '.vue': 'vue', '.svelte': 'svelte',
    '.md': 'markdown', '.mdx': 'mdx',
    '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
    '.proto': 'protobuf',
}

SECRET_PATTERNS = [
    re.compile(r'-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9_]{30,}\b'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
    re.compile(
        r'(password|passwd|secret|api[_-]?key|access[_-]?token)\s*=\s*[\'"]?[^\'"\s]{16,}',
        re.I,
    ),
]

# TS/JS/C-like 顶级声明
_RE_TS_DECL = re.compile(
    r'^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?'
    r'(?P<kw>function|class|interface|type|enum|const|let|var)\s+'
    r'(?P<name>[A-Za-z_$][\w$-]*)',
)
_RE_PY_DECL = re.compile(r'^\s*(?P<kw>def|class)\s+(?P<name>[A-Za-z_][\w]*)')
_RE_GO_DECL = re.compile(
    r'^\s*(?:\(\s*[^\)]*\)\s*)?'
    r'(?P<kw>func|type|var|const)\s+'
    r'(?P<name>[A-Za-z_][\w]*)',
)
_RE_RS_DECL = re.compile(
    r'^\s*(?:pub\s+)?(?P<kw>fn|struct|enum|trait|impl|const|static|mod)\s+'
    r'(?P<name>[A-Za-z_][\w]*)',
)
_RE_JAVA_DECL = re.compile(
    r'^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)*'
    r'(?P<kw>class|interface|enum|void|int|long|boolean|String|double|float|[A-Z][\w<>]*)\s+'
    r'(?P<name>[A-Za-z_][\w]*)',
)

# import 语句
_RE_TS_IMPORT = re.compile(r'''(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]''')
_RE_TS_REQUIRE = re.compile(r'''require\(\s*['"]([^'"]+)['"]\s*\)''')
_RE_PY_FROM_IMPORT = re.compile(r'^\s*from\s+([\w\.]+)\s+import\s+')
_RE_PY_IMPORT = re.compile(r'^\s*import\s+([\w\.]+(?:\s*,\s*[\w\.]+)*)')
_RE_GO_IMPORT_SINGLE = re.compile(r'^\s*import\s+["\']([^"\']+)["\']')
_RE_GO_IMPORT_BLOCK = re.compile(
    r'^\s*import\s*\(([^)]*)\)',
    re.MULTILINE | re.DOTALL,
)
_RE_GO_IMPORT_STR = re.compile(r'''["']([^"']+)["']''')
_RE_RS_USE = re.compile(r'^\s*(?:pub\s+)?use\s+([\w:]+)(?:\s*;|\s*\{)')
_RE_JAVA_IMPORT = re.compile(r'^\s*import\s+(static\s+)?([\w\.]+);')
_RE_MD_LINK = re.compile(r'\[[^\]]+\]\(([^)#?]+)(?:[#?][^)]*)?\)')


# ────────────────────────────── 工具函数 ──────────────────────────────────────


def stable_hex(value: str, length: int = 16) -> str:
    return hashlib.sha1(value.encode('utf-8')).hexdigest()[:length]


def log_err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def is_sensitive_rel(rel: str) -> bool:
    parts = [p.lower() for p in rel.split('/')]
    base = os.path.basename(rel).lower()
    if any(p in SENSITIVE_DIR_NAMES for p in parts):
        return True
    if base in SENSITIVE_FILE_NAMES:
        return True
    if base.startswith('.env.') or base.startswith('id_'):
        return True
    if re.match(r'^service-account.*\.json$', base):
        return True
    _, ext = os.path.splitext(base)
    if ext in SENSITIVE_FILE_EXT:
        return True
    return False


def text_ext(rel: str) -> bool:
    base = os.path.basename(rel).lower()
    if base in {'dockerfile', 'makefile', 'rakefile', 'gemfile', 'podfile',
                'license', 'authors', 'changelog', 'contributing'}:
        return True
    _, ext = os.path.splitext(base)
    return ext in TEXT_EXTS


def matches_any(rel: str, patterns: Iterable[str]) -> bool:
    norm = rel.replace(os.sep, '/')
    for p in patterns:
        if not p:
            continue
        if fnmatch.fnmatch(norm, p) or fnmatch.fnmatch(norm, f'**/{p}'):
            return True
        if p in norm:
            return True
    return False


def detect_secret(text: str) -> bool:
    for pat in SECRET_PATTERNS:
        if pat.search(text):
            return True
    return False


# ────────────────────────────── 扫描核心 ──────────────────────────────────────


@dataclass
class SourceFile:
    path: str
    language: str | None
    lines: list[str]
    content: str
    size: int


@dataclass
class Stats:
    scannedFiles: int = 0
    skippedLargeFiles: int = 0
    skippedBinaryFiles: int = 0
    skippedSensitiveFiles: int = 0
    skippedSecretFiles: int = 0
    chunkCount: int = 0
    edgeCount: int = 0
    symbolCount: int = 0
    dependencyCount: int = 0
    docCount: int = 0
    importEdgeCount: int = 0
    languages: dict[str, int] = field(default_factory=dict)
    totalBytes: int = 0


def walk_repo(
    root: str,
    max_files: int,
    max_file_bytes: int,
    include_patterns: list[str],
    exclude_patterns: list[str],
    stats: Stats,
) -> list[SourceFile]:
    files: list[SourceFile] = []
    root_real = os.path.realpath(root)
    for cur, dirs, names in os.walk(root_real):
        dirs[:] = sorted(
            d for d in dirs
            if d not in DEFAULT_EXCLUDE_DIRS
            and d.lower() not in SENSITIVE_DIR_NAMES
        )
        stop = False
        for name in sorted(names):
            if len(files) >= max_files:
                stop = True
                break
            full = os.path.join(cur, name)
            try:
                rel = os.path.relpath(full, root_real).replace(os.sep, '/')
            except ValueError:
                continue
            if not text_ext(rel):
                continue
            if is_sensitive_rel(rel):
                stats.skippedSensitiveFiles += 1
                continue
            if exclude_patterns and matches_any(rel, exclude_patterns):
                continue
            if include_patterns and not matches_any(rel, include_patterns):
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size > max_file_bytes:
                stats.skippedLargeFiles += 1
                continue
            try:
                with open(full, 'r', encoding='utf-8', errors='replace') as fh:
                    content = fh.read()
            except OSError:
                continue
            if '\0' in content:
                stats.skippedBinaryFiles += 1
                continue
            if detect_secret(content):
                stats.skippedSecretFiles += 1
                continue
            base = os.path.basename(rel).lower()
            lang = None
            _, ext = os.path.splitext(base)
            if ext in LANG_BY_EXT:
                lang = LANG_BY_EXT[ext]
            elif base in {'dockerfile', 'makefile', 'rakefile'}:
                lang = 'shell' if base == 'rakefile' else base
            stats.scannedFiles += 1
            stats.totalBytes += size
            if lang:
                stats.languages[lang] = stats.languages.get(lang, 0) + 1
            files.append(SourceFile(
                path=rel,
                language=lang,
                lines=content.splitlines(),
                content=content,
                size=size,
            ))
        if stop:
            break
    return files


# ────────────────────────────── 符号 / 依赖 / import ─────────────────────────


def extract_symbols(sf: SourceFile) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    lang = sf.language
    lines = sf.lines
    if lang and lang.startswith(('typescript', 'javascript')):
        regex = _RE_TS_DECL
    elif lang == 'python':
        regex = _RE_PY_DECL
    elif lang == 'go':
        regex = _RE_GO_DECL
    elif lang == 'rust':
        regex = _RE_RS_DECL
    elif lang in {'java', 'kotlin'}:
        regex = _RE_JAVA_DECL
    else:
        regex = None

    if regex is None:
        return out
    for idx, line in enumerate(lines):
        m = regex.search(line)
        if not m:
            continue
        kw = m.group('kw')
        name = m.group('name')
        start = max(0, idx - 4)
        end = min(len(lines), idx + 36)
        snippet = '\n'.join(lines[start:end])
        symbol_kind = kw
        exported = bool(re.search(r'\bexport\b', line)) or bool(re.search(r'^\s*pub\b', line))
        out.append({
            'start_line': start + 1,
            'end_line': end,
            'name': name,
            'kind': kw,
            'symbol_kind': symbol_kind,
            'exported': exported,
            'signature': line.strip(),
            'snippet': snippet,
        })
        if len(out) >= 40:
            break
    return out


def extract_imports(sf: SourceFile) -> list[str]:
    c = sf.content
    targets: list[str] = []
    if sf.language and sf.language.startswith(('typescript', 'javascript')):
        for m in _RE_TS_IMPORT.finditer(c):
            targets.append(m.group(1))
        for m in _RE_TS_REQUIRE.finditer(c):
            targets.append(m.group(1))
    elif sf.language == 'python':
        for m in _RE_PY_FROM_IMPORT.finditer(c):
            targets.append(m.group(1))
        for m in _RE_PY_IMPORT.finditer(c):
            for part in re.split(r'\s*,\s*', m.group(1)):
                if part.strip():
                    targets.append(part.strip().split('.')[0])
    elif sf.language == 'go':
        for m in _RE_GO_IMPORT_SINGLE.finditer(c):
            targets.append(m.group(1))
        for block in _RE_GO_IMPORT_BLOCK.finditer(c):
            for sm in _RE_GO_IMPORT_STR.finditer(block.group(1)):
                targets.append(sm.group(1))
    elif sf.language == 'rust':
        for m in _RE_RS_USE.finditer(c):
            crate_name = m.group(1).split(':')[0].split('::')[0]
            if crate_name and crate_name != 'crate' and crate_name != 'self' and crate_name != 'super':
                targets.append(crate_name)
    elif sf.language in {'java', 'kotlin'}:
        for m in _RE_JAVA_IMPORT.finditer(c):
            targets.append(m.group(2))
    return targets


def resolve_internal(target: str, from_path: str, file_set: set[str]) -> str | None:
    if not target.startswith('.') and not target.startswith('/'):
        return None
    if target.startswith('/'):
        base = target.lstrip('/')
    else:
        base = os.path.normpath(os.path.join(os.path.dirname(from_path), target)).replace(os.sep, '/')
    candidates = [base] + [f'{base}{ext}' for ext in (
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.mts',
        '.py', '.go', '.rs', '.java', '.kt', '.md', '.mdx',
    )] + [os.path.join(base, f'index{ext}') for ext in (
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    )]
    for c in candidates:
        if c in file_set:
            return c
    return None


def package_name(target: str, lang: str | None) -> str:
    if lang == 'python':
        return target.split('.')[0]
    if target.startswith('@'):
        parts = target.split('/')
        return '/'.join(parts[:2]) if len(parts) >= 2 else target
    return target.split('/')[0] or target


def extract_dependency_chunk(sf: SourceFile) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    base = os.path.basename(sf.path).lower()
    if base == 'package.json':
        try:
            pkg = json.loads(sf.content)
        except Exception:
            return None, []
        entries: list[str] = []
        for section in ('dependencies', 'devDependencies',
                        'peerDependencies', 'optionalDependencies'):
            if isinstance(pkg.get(section), dict):
                entries.extend(f'{n}@{v}' for n, v in pkg[section].items())
        entries = entries[:500]
        if not entries:
            return None, []
        chunk = {
            'key': f'dep:{sf.path}',
            'path': sf.path,
            'kind': 'dependency',
            'name': base,
            'content': '\n'.join(entries),
            'keywords': ' '.join(package_name(e.split('@')[0], 'typescript') for e in entries)[:4096],
            'metadata': {'dependencyCount': len(entries), 'source': 'package.json'},
        }
        edges = []
        for entry in entries:
            pname = package_name(entry.split('@')[0], 'typescript')
            edges.append({
                'key': f'dep:{sf.path}:{pname}',
                'fromPath': sf.path,
                'edgeKind': 'depends_on',
                'packageName': pname,
                'source': 'builtin-graph-scan',
                'metadata': {'dependency': entry},
            })
        return chunk, edges
    if base == 'requirements.txt':
        entries = [ln.strip() for ln in sf.content.splitlines()
                   if ln.strip() and not ln.strip().startswith('#')]
        entries = entries[:500]
        if not entries:
            return None, []
        chunk = {
            'key': f'dep:{sf.path}',
            'path': sf.path,
            'kind': 'dependency',
            'name': base,
            'content': '\n'.join(entries),
            'keywords': ' '.join(package_name(e.split('==')[0].split('>=')[0].split('<=')[0], 'python')
                                for e in entries)[:4096],
            'metadata': {'dependencyCount': len(entries), 'source': 'requirements.txt'},
        }
        edges = []
        for entry in entries:
            head = entry.split(';', 1)[0]
            pname = package_name(re.split(r'[<>=!~\s\[]', head, 1)[0], 'python')
            if pname:
                edges.append({
                    'key': f'dep:{sf.path}:{pname}',
                    'fromPath': sf.path,
                    'edgeKind': 'depends_on',
                    'packageName': pname,
                    'source': 'builtin-graph-scan',
                    'metadata': {'dependency': entry},
                })
        return chunk, edges
    if base == 'go.mod':
        reqs = [m.group(1) for m in re.finditer(r'^\s*([\w./\-]+)\s+v[\w.\-+]+', sf.content, re.M)]
        reqs = reqs[:500]
        if not reqs:
            return None, []
        chunk = {
            'key': f'dep:{sf.path}',
            'path': sf.path,
            'kind': 'dependency',
            'name': base,
            'content': '\n'.join(reqs),
            'keywords': ' '.join(r.split('/')[-1] for r in reqs)[:4096],
            'metadata': {'dependencyCount': len(reqs), 'source': 'go.mod'},
        }
        edges = [{
            'key': f'dep:{sf.path}:{r}',
            'fromPath': sf.path,
            'edgeKind': 'depends_on',
            'packageName': r,
            'source': 'builtin-graph-scan',
            'metadata': {'dependency': r},
        } for r in reqs]
        return chunk, edges
    if base == 'cargo.toml':
        deps_section = False
        names: list[str] = []
        for ln in sf.content.splitlines():
            s = ln.strip()
            if s.startswith('['):
                deps_section = s in ('[dependencies]', '[dev-dependencies]', '[build-dependencies]')
                continue
            if deps_section and s and '=' in s and not s.startswith('#'):
                head = s.split('=', 1)[0].strip()
                if head and '"' not in head and '.' not in head:
                    names.append(head)
        names = names[:500]
        if not names:
            return None, []
        chunk = {
            'key': f'dep:{sf.path}',
            'path': sf.path,
            'kind': 'dependency',
            'name': base,
            'content': '\n'.join(names),
            'keywords': ' '.join(names)[:4096],
            'metadata': {'dependencyCount': len(names), 'source': 'Cargo.toml'},
        }
        edges = [{
            'key': f'dep:{sf.path}:{n}',
            'fromPath': sf.path,
            'edgeKind': 'depends_on',
            'packageName': n,
            'source': 'builtin-graph-scan',
            'metadata': {'dependency': n},
        } for n in names]
        return chunk, edges
    return None, []


def extract_doc_chunks(sf: SourceFile) -> list[dict[str, Any]]:
    if not sf.language or sf.language not in ('markdown', 'mdx'):
        return []
    lines = sf.lines
    headings: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = re.match(r'^(#{1,6})\s+(.+?)\s*#*\s*$', line)
        if m:
            headings.append((i, m.group(2).strip()))
    out: list[dict[str, Any]] = []
    if not headings:
        out.append({
            'key': f'doc:{sf.path}',
            'path': sf.path,
            'kind': 'doc',
            'name': os.path.basename(sf.path),
            'content': sf.content[:128 * 1024],
            'keywords': sf.path,
            'metadata': {'heading': os.path.basename(sf.path), 'level': 0},
        })
        return out
    for idx, (line_no, title) in enumerate(headings[:40]):
        end = headings[idx + 1][0] if idx + 1 < len(headings) else len(lines)
        start = line_no
        content = '\n'.join(lines[start:end])[:128 * 1024]
        level = len(lines[line_no].split()[0])
        # 收集这一节内的相对路径链接
        links = [m.group(1) for m in _RE_MD_LINK.finditer(content)
                 if not re.match(r'^https?://', m.group(1), re.I)
                 and not m.group(1).startswith('mailto:')][:20]
        out.append({
            'key': f'doc:{sf.path}:{start + 1}:{title}',
            'path': sf.path,
            'kind': 'doc',
            'name': title,
            'startLine': start + 1,
            'endLine': max(start + 1, end),
            'content': content,
            'keywords': f'{sf.path} {title}',
            'metadata': {
                'heading': title,
                'level': level,
                'links': links,
            },
        })
    return out


def extract_doc_edges(sf: SourceFile, file_set: set[str]) -> list[dict[str, Any]]:
    if not sf.language or sf.language not in ('markdown', 'mdx'):
        return []
    edges: list[dict[str, Any]] = []
    for m in _RE_MD_LINK.finditer(sf.content):
        target = m.group(1).strip()
        if not target or re.match(r'^https?://', target, re.I) or target.startswith('mailto:'):
            continue
        resolved = None
        if target in file_set:
            resolved = target
        else:
            candidate = os.path.normpath(os.path.join(os.path.dirname(sf.path), target)).replace(os.sep, '/')
            if candidate in file_set:
                resolved = candidate
        if not resolved:
            continue
        edges.append({
            'key': f'docref:{sf.path}:{resolved}',
            'fromPath': sf.path,
            'toPath': resolved,
            'edgeKind': 'documents',
            'source': 'builtin-graph-scan',
            'metadata': {'rawTarget': target},
        })
        if len(edges) >= 80:
            break
    return edges


# ────────────────────────────── 组装输出 ─────────────────────────────────────


def build(
    repo_root: str,
    repo_name: str,
    max_files: int,
    max_file_bytes: int,
    include_patterns: list[str],
    exclude_patterns: list[str],
    include_docs: bool,
    include_deps: bool,
    include_imports: bool,
    revision: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str]:
    stats = Stats()
    files = walk_repo(repo_root, max_files, max_file_bytes,
                      include_patterns, exclude_patterns, stats)
    file_set = {sf.path for sf in files}
    chunks: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    # overview
    langs = ', '.join(f'{k}({v})' for k, v in sorted(stats.languages.items(), key=lambda x: -x[1]))
    top_files = '\n'.join(f'- {sf.path}' for sf in files[:80])
    overview_lines = [
        f'Repo: {repo_name}',
        f'Kind: local-workspace',
        *(f'Revision: {revision}' if revision else []),
        f'Indexed files: {len(files)}',
        f'Languages: {langs}',
        'Key files:',
        top_files,
    ]
    summary_md = '\n'.join(overview_lines)
    chunks.append({
        'key': 'overview',
        'path': '__overview__',
        'kind': 'overview',
        'name': repo_name,
        'content': summary_md,
        'keywords': f'{repo_name} {" ".join(stats.languages.keys())}',
        'metadata': {
            'scannedFiles': stats.scannedFiles,
            'languages': dict(stats.languages),
        },
    })

    chunk_ids: set[str] = set()
    edge_ids: set[str] = set()

    def add_chunk(c: dict[str, Any]) -> None:
        _h = stable_hex('repo:' + repo_name + ':' + str(c.get('kind', '')) + ':' + str(c.get('key', '')))
        cid = f'rk_{_h}'
        if cid in chunk_ids:
            return
        chunk_ids.add(cid)
        start_line = c.get('startLine') or c.get('start_line')
        end_line = c.get('endLine') or c.get('end_line')
        name = c.get('name')
        language = c.get('language')
        keywords = c.get('keywords', '')
        out_chunk: dict[str, Any] = {
            'key': c['key'],
            'path': c.get('path', ''),
            'kind': c['kind'],
            'content': c['content'][:128 * 1024],
            'metadata': c.get('metadata', {}) or {},
        }
        if name:
            out_chunk['name'] = name
        if language:
            out_chunk['language'] = language
        if start_line:
            out_chunk['startLine'] = start_line
        if end_line:
            out_chunk['endLine'] = end_line
        if keywords:
            out_chunk['keywords'] = keywords[:4096]
        out_chunk['metadata'].setdefault('provider', 'builtin-graph-scan')
        chunks.append(out_chunk)
        stats.chunkCount += 1

    def add_edge(e: dict[str, Any]) -> None:
        _h = stable_hex('repo:' + repo_name + ':' + str(e.get('edgeKind', '')) + ':' + str(e.get('key', '')))
        eid = f'rke_{_h}'
        if eid in edge_ids:
            return
        edge_ids.add(eid)
        e.setdefault('source', 'builtin-graph-scan')
        out_edge: dict[str, Any] = {
            'key': e['key'],
            'fromPath': e.get('fromPath', ''),
            'edgeKind': e['edgeKind'],
            'source': e['source'],
            'metadata': e.get('metadata', {}) or {},
        }
        if e.get('toPath'):
            out_edge['toPath'] = e['toPath']
        if e.get('symbol'):
            out_edge['symbol'] = e['symbol']
        if e.get('packageName'):
            out_edge['packageName'] = e['packageName']
        edges.append(out_edge)
        stats.edgeCount += 1
        if e['edgeKind'] == 'imports':
            stats.importEdgeCount += 1

    # file chunks + symbols + deps + imports + doc
    for sf in files:
        add_chunk({
            'key': f'file:{sf.path}',
            'path': sf.path,
            'kind': 'file',
            'name': os.path.basename(sf.path),
            'language': sf.language,
            'startLine': 1,
            'endLine': max(1, len(sf.lines)),
            'content': sf.content,
            'keywords': f'{sf.path} {sf.language or ""}',
            'metadata': {'size': sf.size, 'lines': len(sf.lines)},
        })

        for sym in extract_symbols(sf):
            stats.symbolCount += 1
            add_chunk({
                'key': f'symbol:{sf.path}:{sym["start_line"]}:{sym["name"]}',
                'path': sf.path,
                'kind': 'symbol',
                'name': sym['name'],
                'language': sf.language,
                'startLine': sym['start_line'],
                'endLine': sym['end_line'],
                'content': sym['snippet'],
                'keywords': sym['name'],
                'metadata': {
                    'symbolKind': sym['symbol_kind'],
                    'signature': sym['signature'],
                    'exported': sym['exported'],
                    'confidence': 'heuristic',
                },
            })

        if include_deps:
            dep_chunk, dep_edges = extract_dependency_chunk(sf)
            if dep_chunk:
                stats.dependencyCount += 1
                add_chunk(dep_chunk)
                for e in dep_edges:
                    add_edge(e)

        if include_imports:
            seen_imports: set[str] = set()
            for target in extract_imports(sf):
                dedup_key = f'{target}\0{sf.path}'
                if dedup_key in seen_imports:
                    continue
                seen_imports.add(dedup_key)
                resolved = resolve_internal(target, sf.path, file_set)
                is_internal = target.startswith('.') or target.startswith('/')
                pname = None if is_internal else package_name(target, sf.language)
                add_edge({
                    'key': f'imports:{sf.path}:{target}',
                    'fromPath': sf.path,
                    'toPath': resolved,
                    'edgeKind': 'imports',
                    'packageName': pname,
                    'symbol': None,
                    'source': 'builtin-graph-scan',
                    'metadata': {
                        'rawTarget': target,
                        'resolved': bool(resolved),
                        'internal': is_internal,
                    },
                })
                # imported_by 反向边
                if resolved:
                    add_edge({
                        'key': f'imported_by:{resolved}:{sf.path}',
                        'fromPath': resolved,
                        'toPath': sf.path,
                        'edgeKind': 'imported_by',
                        'source': 'builtin-graph-scan',
                        'metadata': {'reverseOf': f'imports:{sf.path}:{target}'},
                    })

        if include_docs:
            for d in extract_doc_chunks(sf):
                stats.docCount += 1
                add_chunk(d)
            for e in extract_doc_edges(sf, file_set):
                add_edge(e)

    final_stats: dict[str, Any] = {
        'generator': 'builtin-graph-scan',
        'generatorVersion': 1,
        'repoName': repo_name,
        'repoRoot': os.path.realpath(repo_root),
        'revision': revision,
        **asdict(stats),
    }
    return chunks, edges, final_stats, summary_md


# ────────────────────────────── CLI ───────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog='builtin-graph-scan')
    ap.add_argument('--repo', default=os.getcwd(), help='仓库根目录（默认 $PWD）')
    ap.add_argument('--output-dir', default=None,
                    help='产物输出目录（默认 <repo>/.octodeck/knowledge）')
    ap.add_argument('--repo-name', default=None,
                    help='仓库显示名（默认取 --repo basename）')
    ap.add_argument('--revision', default=None,
                    help='git revision 或任意标识，写入 stats')
    ap.add_argument('--max-files', type=int, default=800)
    ap.add_argument('--max-file-bytes', type=int, default=64 * 1024)
    ap.add_argument('--include', action='append', default=[],
                    help='include glob，可重复指定（默认全包含）')
    ap.add_argument('--exclude', action='append', default=[],
                    help='exclude glob，可重复指定')
    ap.add_argument('--include-docs', dest='include_docs',
                    action='store_true', default=True)
    ap.add_argument('--no-include-docs', dest='include_docs', action='store_false')
    ap.add_argument('--include-deps', dest='include_deps',
                    action='store_true', default=True)
    ap.add_argument('--no-include-deps', dest='include_deps', action='store_false')
    ap.add_argument('--include-imports', dest='include_imports',
                    action='store_true', default=True)
    ap.add_argument('--no-include-imports', dest='include_imports', action='store_false')
    ap.add_argument('--pretty', action='store_true', default=False,
                    help='紧凑 JSON 默认关闭；开启后写 indent=2，体积会变大')
    ap.add_argument('--max-output-mb', type=float, default=None,
                    help='单个输出文件（chunks.json / edges.json）最大 MB，超过时主动报错退出')
    return ap.parse_args()


def _estimate_dir_bytes(directory: str) -> int:
    total = 0
    for name in os.listdir(directory):
        try:
            total += os.path.getsize(os.path.join(directory, name))
        except OSError:
            pass
    return total


def _atomic_write(path: str, data: str) -> None:
    """原子写：先写到同目录 .tmp 文件，fsync 后 rename。避免中断产生半截 JSON。"""
    tmp_path = f'{path}.{os.getpid()}.tmp'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


def main() -> int:
    t0 = time.time()
    args = parse_args()

    repo_root = os.path.realpath(args.repo)
    if not os.path.isdir(repo_root):
        log_err(f'ERROR: --repo 不是目录: {repo_root}')
        return 2

    repo_name = (args.repo_name or os.path.basename(repo_root.rstrip('/'))).strip() or 'repo'
    output_dir = args.output_dir or os.path.join(repo_root, '.octodeck', 'knowledge')
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        log_err(f'ERROR: 创建 output-dir 失败: {exc}')
        return 3

    # stderr tee 到 run.log（供 Agent 作为 observability 产物上传）
    run_log_path = os.path.join(output_dir, 'run.log')
    _run_log_fh = open(run_log_path, 'a', encoding='utf-8', buffering=1)  # line-buffered

    class _TeeStderr:
        def __init__(self, original, log_fh):  # noqa: ANN001
            self._orig = original
            self._fh = log_fh

        def write(self, data: str) -> int:
            if data:
                try:
                    self._fh.write(data)
                except Exception:  # noqa: BLE001
                    pass
            return self._orig.write(data)

        def flush(self) -> None:
            try:
                self._fh.flush()
            except Exception:  # noqa: BLE001
                pass
            self._orig.flush()

    sys.stderr = _TeeStderr(sys.stderr, _run_log_fh)  # type: ignore[assignment]

    def _runlog(msg: str) -> None:
        line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
        try:
            _run_log_fh.write(line + '\n')
            _run_log_fh.flush()
        except Exception:  # noqa: BLE001
            pass

    _runlog(
        f'START repo_root={repo_root} repo_name={repo_name} '
        f'max_files={args.max_files} max_file_bytes={args.max_file_bytes} '
        f'include_docs={args.include_docs} include_deps={args.include_deps} '
        f'include_imports={args.include_imports} output_dir={output_dir}'
    )
    try:
        chunks, edges, stats_obj, summary_md = build(
            repo_root=repo_root,
            repo_name=repo_name,
            max_files=max(1, min(args.max_files, 20000)),
            max_file_bytes=max(512, min(args.max_file_bytes, 2 * 1024 * 1024)),
            include_patterns=list(args.include),
            exclude_patterns=list(args.exclude),
            include_docs=args.include_docs,
            include_deps=args.include_deps,
            include_imports=args.include_imports,
            revision=args.revision,
        )
    except Exception as exc:  # noqa: BLE001
        _runlog(f'FAIL build exception: {exc!r}')
        log_err(f'ERROR: build 阶段异常: {exc!r}')
        return 4

    _runlog(
        f'BUILD scannedFiles={stats_obj.get("scannedFiles")} '
        f'chunks={stats_obj.get("chunkCount")} edges={stats_obj.get("edgeCount")} '
        f'symbols={stats_obj.get("symbolCount")} deps={stats_obj.get("dependencyCount")} '
        f'docs={stats_obj.get("docCount")} '
        f'skippedLarge={stats_obj.get("skippedLargeFiles")} skippedBinary={stats_obj.get("skippedBinaryFiles")} '
        f'skippedSensitive={stats_obj.get("skippedSensitiveFiles")} skippedSecret={stats_obj.get("skippedSecretFiles")}'
    )

    write_kwargs: dict[str, Any] = {'ensure_ascii': False}
    if args.pretty:
        write_kwargs['indent'] = 2

    stats_obj['durationMs'] = int((time.time() - t0) * 1000)
    stats_obj['outputDir'] = output_dir
    # summary.md 追加 Stats 代码块（展示用），不影响 stats.json
    summary_display = (
        summary_md
        + '\n\n## Stats\n\n```json\n'
        + json.dumps(stats_obj, ensure_ascii=False, indent=2)
        + '\n```\n'
    )

    # 预序列化 + 单文件体积预算（--max-output-mb），避免写磁盘后再失败
    chunks_json = json.dumps(chunks, **write_kwargs)
    edges_json = json.dumps(edges, **write_kwargs)
    stats_json = json.dumps(stats_obj, indent=2 if args.pretty else None, ensure_ascii=False)
    if args.max_output_mb and args.max_output_mb > 0:
        cap_bytes = int(args.max_output_mb * 1024 * 1024)
        if len(chunks_json) > cap_bytes:
            _runlog(f'FAIL chunks.json {len(chunks_json)} bytes exceed --max-output-mb={args.max_output_mb}')
            log_err(f'ERROR: chunks.json 超过 --max-output-mb={args.max_output_mb} 阈值，请降低 --max-files')
            return 6
        if len(edges_json) > cap_bytes:
            _runlog(f'FAIL edges.json {len(edges_json)} bytes exceed --max-output-mb={args.max_output_mb}')
            log_err(f'ERROR: edges.json 超过 --max-output-mb={args.max_output_mb} 阈值，请降低 --max-files')
            return 6

    try:
        _atomic_write(os.path.join(output_dir, 'chunks.json'), chunks_json)
        _atomic_write(os.path.join(output_dir, 'edges.json'), edges_json)
        _atomic_write(os.path.join(output_dir, 'stats.json'), stats_json)
        _atomic_write(os.path.join(output_dir, 'summary.md'), summary_display)
    except OSError as exc:
        _runlog(f'FAIL write artifact: {exc!r}')
        log_err(f'ERROR: 写产物失败: {exc}')
        return 5

    _runlog(f'DONE output_dir={output_dir} files={len(os.listdir(output_dir))} total_size={_estimate_dir_bytes(output_dir)}')
    try:
        _run_log_fh.close()
    except Exception:  # noqa: BLE001
        pass

    result = {
        'ok': True,
        'chunks': len(chunks),
        'edges': len(edges),
        'output_dir': output_dir,
        'duration_ms': int((time.time() - t0) * 1000),
        'stats': stats_obj,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
