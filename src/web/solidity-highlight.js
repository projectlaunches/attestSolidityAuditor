const KEYWORDS = new Set([
  "abstract", "after", "alias", "apply", "as", "assembly", "break", "case", "catch", "constant", "constructor",
  "continue", "contract", "default", "delete", "do", "else", "emit", "enum", "error", "event", "external",
  "fallback", "false", "final", "for", "from", "function", "if", "immutable", "implements", "import", "in",
  "indexed", "inline", "interface", "internal", "is", "let", "library", "mapping", "match", "memory", "modifier",
  "mutable", "new", "null", "of", "override", "payable", "pragma", "private", "public", "pure", "receive",
  "reference", "relocatable", "return", "returns", "revert", "sealed", "sizeof", "static", "storage", "struct",
  "super", "supports", "switch", "this", "throw", "true", "try", "type", "typedef", "typeof", "unchecked",
  "using", "var", "view", "virtual", "while",
]);

const BUILTINS = new Set([
  "abi", "assert", "block", "blockhash", "ecrecover", "gasleft", "keccak256", "msg", "now", "require", "ripemd160",
  "selfdestruct", "sha256", "sha3", "suicide", "tx",
]);

const TITLE_KEYWORDS = new Set(["contract", "interface", "library", "function", "modifier", "event", "error", "struct", "enum"]);
const TOKEN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|hex"(?:\\.|[^"\\])*"|0x[a-fA-F\d]+|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[A-Za-z_$][\w$]*\b|=>|:=|==|!=|<=|>=|\+\+|--|&&|\|\||\*\*|<<|>>|[+\-*/%&|^~!=<>?:]+|\s+|./gy;

export function highlightSolidity(source) {
  let output = "";
  let expectTitle = false;
  TOKEN.lastIndex = 0;

  for (let match = TOKEN.exec(source); match; match = TOKEN.exec(source)) {
    const token = match[0];
    let kind = "";

    if (/^\/[/\*]/.test(token)) kind = "comment";
    else if (/^(?:hex)?["']/.test(token)) kind = "string";
    else if (/^(?:0x|\d)/i.test(token)) kind = "number";
    else if (/^[A-Za-z_$]/.test(token)) {
      if (expectTitle) {
        kind = "title";
        expectTitle = false;
      } else if (KEYWORDS.has(token)) {
        kind = "keyword";
        expectTitle = TITLE_KEYWORDS.has(token);
      } else if (/^(?:u?int\d*|bytes\d*|address|bool|string|fixed\d*x?\d*|ufixed\d*x?\d*)$/.test(token)) {
        kind = "type";
      } else if (BUILTINS.has(token)) {
        kind = "builtin";
      } else if (/^\s*\(/.test(source.slice(TOKEN.lastIndex))) {
        kind = "function";
      }
    } else if (!/^\s+$/.test(token)) {
      kind = "operator";
    }

    const escaped = escapeHtml(token);
    output += kind ? `<span class="tok-${kind}">${escaped}</span>` : escaped;
  }

  return output;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
