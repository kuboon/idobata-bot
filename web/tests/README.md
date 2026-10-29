# web/tests — ブラウザ smoke

opt-in のブラウザテスト。デフォルトの `deno task test`
には含まれず、`deno task test:browser` で明示的に起動する。lightpanda バイナリは
`deno run -A npm:@lightpanda/browser install` で取得するか、GitHub のリリース
（`https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux`
など）から取って `LIGHTPANDA_EXECUTABLE_PATH` にパスを渡す。CI は後者
（`install` が照合する `versions.json` のチェックサムが nightly
と食い違うことがあるため）。

## 前提

- ルーターは起動時に `Deno.bundle` で client を bundle する
  (`web/server/assets.ts`) ので、事前のビルド手順は不要。

## 実行

```bash
deno task test:browser    # root から
```

## カバー範囲

- `browser_smoke.test.ts` — `/my` を開き、`globalThis.__rmxReady`
  が立つまで待ってから、サインインカードが「セッションを確認しています…」
  の状態を抜けることを確かめる。SSR → chunk の動的 import → island の setup
  のフル経路を exercise する。
