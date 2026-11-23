// 格式和 import 排序归 Biome；ESLint 只管会出错和难读的写法。
import antfu from "@antfu/eslint-config";
import { eslint_plugin_vibe_proof as vibeProof } from "eslint-plugin-vibe-proof";

// AGENTS.md：mind/、mechanisms/、speech/ 不读时钟、不取随机数、不做 I/O，时间只来自 event.at。
const PURE = ["src/mind/**", "src/mechanisms/**", "src/speech/**"];
const IMPURE_MODULES = [
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
  "better-sqlite3",
].flatMap((name) => [name, `node:${name}`]);
const IMPURE_SYNTAX = [
  ["Date.now", "时间只来自 event.at"],
  ["performance.now", "时间只来自 event.at"],
  ["Math.random", "随机数由调用方从种子传进来"],
].map(([callee, why]) => {
  const [object, property] = callee.split(".");
  return {
    selector: `CallExpression[callee.object.name='${object}'][callee.property.name='${property}']`,
    message: `${callee}() 不能出现在纯函数层：${why}。`,
  };
});

export default antfu(
  {
    stylistic: false,
    antislop: true,
    typescript: { tsconfigPath: "./tsconfig.json" },
    ignores: ["**/*", "!src/**", "!test/**"],
    jsonc: false,
    yaml: false,
    toml: false,
    markdown: false,
    pnpm: false,
  },
  {
    name: "alice/vibe-proof",
    files: ["**/*.ts"],
    plugins: { "vibe-proof": vibeProof },
    rules: {
      "vibe-proof/ban-eslint-disable": "error",
      "vibe-proof/no-eager-await-in-condition": "error",
      "vibe-proof/prefer-array-at-for-last-item": "error",
      "vibe-proof/prefer-array-from-mapper": "error",
      "vibe-proof/prefer-array-some": "error",
      "vibe-proof/prefer-throw-if-no-entry": "error",
      "vibe-proof/prefer-timer-args": "error",
      "vibe-proof/no-indexof-equality": "error",
    },
  },
  {
    name: "alice/rules",
    rules: {
      // 这几条只换写法、不提升可读性，或者和 Biome 的格式与 import 整理打架。
      "perfectionist/sort-imports": "off",
      "perfectionist/sort-named-imports": "off",
      "perfectionist/sort-named-exports": "off",
      "import/consistent-type-specifier-style": "off",
      "node/prefer-global/buffer": "off",
      "node/prefer-global/process": "off",
      "unicorn/number-literal-case": "off",
      "test/prefer-lowercase-title": "off",
      "ts/no-use-before-define": "off",
      // 中文的破折号是正当标点，提示词里的又是测过的内容，不能按英文习惯删。
      "slop/no-em-dash": "off",
      // 正则里有意写的中日文和西里尔字母区间。
      "regexp/no-obscure-range": "off",

      // 删掉 switch 分支末尾的 return 会让分支看起来像有意掉进下一个。
      "no-useless-return": "off",
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      "ts/promise-function-async": ["error", { checkArrowFunctions: false }],
      "ts/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: false },
      ],
      // 只拦 0 和 NaN 被当成"没有"的数字判断；空串和 null 同当"没有"是本仓库的惯用写法。
      "ts/strict-boolean-expressions": [
        "error",
        {
          allowString: true,
          allowNumber: true,
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowNullableString: true,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
    },
  },
  {
    name: "alice/pure-layers",
    files: PURE,
    rules: {
      "no-restricted-imports": ["error", { paths: IMPURE_MODULES }],
      "no-restricted-syntax": [
        "error",
        ...IMPURE_SYNTAX,
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "new Date() 读了时钟：时间只来自 event.at。",
        },
        { selector: "CallExpression[callee.name='fetch']", message: "纯函数层不做 I/O。" },
      ],
    },
  },
  {
    name: "alice/cli",
    files: ["src/sim/**", "src/northstar.ts", "src/import-history.ts"],
    rules: { "no-console": "off" },
  },
);
