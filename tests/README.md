# Test Strategy

## Framework Assignment

| Directory | Runner | Purpose |
|-----------|--------|---------|
| `tests/unit/` | `node --test` | 단위 테스트 — mock/stub 기반, DB 불필요 |
| `tests/integration/` | `node --test` | 통합 테스트 — 실제 DB/Redis 연결 필요 |
| `tests/e2e/` | `node --test` | E2E — 서버 프로세스 기동 후 HTTP 요청 |
| `tests/*.test.js` (루트) | Jest | 레거시 — 점진적으로 `tests/unit/`으로 마이그레이션 |

## Commands

| Command | Scope |
|---------|-------|
| `npm test` | unit 전체 (Jest + Node test runner) |
| `npm run test:jest` | Jest 루트 테스트만 |
| `npm run test:unit:node` | Node test runner unit 테스트만 |
| `npm run test:integration` | 통합 + e2e (DB/Redis 필요) |
| `npm run test:e2e` | e2e만 |
| `node --test tests/unit/<file>.test.js` | 단일 파일 실행 |

## Conventions

- 파일명: `<module-name>.test.js`
- 새 테스트는 반드시 `tests/unit/`에 Node test runner로 작성
- Jest 루트 테스트(`tests/*.test.js`)는 신규 추가 금지, 기존 것만 유지
- 장기적으로 Jest -> Node test runner 단일화 마이그레이션 예정
- Given-When-Then 또는 Arrange-Act-Assert 패턴 사용
- describe 블록으로 모듈/기능 단위 그룹화
- mock은 `node:test`의 `mock.fn()` 사용 (Jest의 `jest.fn()` 아님)

## Lifecycle 가드 (active handle 누수 방지)

### 배경

일부 모듈(`lib/sessions.js`, `lib/memory/ReflectProcessor.js` 등)은 import 시점에
ioredis 클라이언트나 prom-client `collectDefaultMetrics` timer를 활성화한다.
after 훅에서 정리하지 않으면 node:test runner가 event loop를 14초 대기 후
"Promise resolution is still pending" 메시지와 함께 hang한다.

### 환경변수

`npm run test:unit:node` 는 `MEMENTO_METRICS_DEFAULT=off` 를 자동으로 주입한다.
이 환경변수가 없으면 prom-client default metrics timer가 활성화되어 hang이 발생한다.
단일 파일 실행 시에도 반드시 환경변수를 설정해야 한다:

```bash
MEMENTO_METRICS_DEFAULT=off node --experimental-test-module-mocks --test tests/unit/<file>.test.js
```

### assertCleanShutdown 헬퍼

`tests/_lifecycle.js`가 `assertCleanShutdown()` 헬퍼를 export한다.
after 훅 말미에 호출하면 active handle이 남아 있을 경우 즉시 실패하여 hang 대신 명확한 에러를 반환한다.

```js
import { assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  try { await redisClient.quit(); }    catch (_) {}
  try { await getPrimaryPool()?.end(); } catch (_) {}
  await assertCleanShutdown();          // handle 누수 검증
});
```

#### 신규 unit 테스트 작성 체크리스트

1. import가 timer 또는 HTTP agent를 활성화하는지 확인 (lib/sessions, lib/metrics, lib/redis 경유 여부)
2. 활성화된다면 after 훅에서 `redisClient.quit()` + `getPrimaryPool()?.end()` 호출
3. 훅 마지막에 `await assertCleanShutdown()` 추가
4. 단독 실행 시 exit 0 확인: `MEMENTO_METRICS_DEFAULT=off node --test tests/unit/<file>.test.js`

#### 통합 테스트

통합 테스트는 외부 서비스 소켓이 더 많으므로 ignoreNames를 확장한다:

```js
import { assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  // 정리 후
  await assertCleanShutdown({ ignoreNames: ["TCP", "TLSSocket"], ignoreRequests: true });
});
```

### 회귀 감지

`tests/unit/test-lifecycle-guard.test.js`가 5개 케이스로 헬퍼 동작을 검증한다:

| 케이스 | 내용 | 기대 |
|-|-|-|
| 1 | 빈 테스트 | clean |
| 2 | setInterval + unref | clean (ignoreNames: ["Timeout"]) |
| 3 | setInterval no unref | assertCleanShutdown이 누수 감지 (negative) |
| 4 | sessions.js + cleanup | clean (CP2 의존) |
| 5 | ReflectProcessor + cleanup | clean (CP2 의존) |

## Migration Guide (Jest -> Node test runner)

루트 Jest 테스트를 마이그레이션할 때:

1. `tests/unit/`로 파일 이동
2. `jest` import를 `node:test`로 교체:
   - `describe, it, expect` -> `describe, it` from `node:test` + `assert` from `node:assert/strict`
   - `jest.fn()` -> `mock.fn()`
   - `expect(x).toBe(y)` -> `assert.strictEqual(x, y)`
   - `expect(x).toEqual(y)` -> `assert.deepStrictEqual(x, y)`
   - `expect(fn).toThrow()` -> `assert.throws(fn)`
3. 원본 Jest 파일 삭제
4. `npm test` 전체 통과 확인
