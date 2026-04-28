# Stock Insight PWA

미국 주식 또는 ETF 한 종목을 검색해 7개 핵심 지표와 최근 1년 분기 흐름을 보여주는 PWA입니다.

- PER
- PBR
- ROE
- ROIC
- 영업이익률
- 부채비율
- 배당수익률

미국 주식 검색은 SEC 종목 마스터를 사용하고, 재무/가격/ETF 데이터는 Financial Modeling Prep 데이터를 사용합니다.

## 배포 구조

현재 프로젝트는 Cloudflare Workers Builds 기준입니다.

- Worker 진입점: `src/index.js`
- 정적 자산: `public/`
- API 로직: `functions/`

Wrangler가 `public/`을 정적 자산으로 배포하고, `/api/*` 요청은 Worker가 처리합니다.

## 환경변수

Cloudflare 프로젝트 환경변수에 아래 값을 넣어야 합니다.

- `FMP_API_KEY`
  - 미국 주식/ETF 재무 및 가격 조회용
- `SEC_CONTACT_EMAIL`
  - SEC 요청 헤더에 넣을 이메일

## 데이터 소스

- 미국 종목 검색: SEC `company_tickers_exchange.json`
- 미국 주식/ETF 재무 및 가격: Financial Modeling Prep
- USD/KRW 환율: exchangerate.host

## 주요 파일

- `public/index.html`: 화면 레이아웃
- `public/styles.css`: 스타일
- `public/app.js`: 검색, 상세 조회, 백테스트, 렌더링
- `public/service-worker.js`: PWA 캐시
- `src/index.js`: Worker 진입점
- `functions/api/master.js`: 미국 주식/ETF 마스터 목록 API
- `functions/api/stock.js`: 미국 주식/ETF 상세 API
- `functions/api/backtest.js`: 미국 종목 백테스트 API
- `functions/api/health.js`: 환경변수 상태 확인 API
- `functions/_lib/us.js`: 미국 주식 데이터 로직
- `functions/_lib/us-etf.js`: 미국 ETF 데이터 로직
- `functions/_lib/us-backtest.js`: 백테스트 데이터 로직

## 확인 방법

배포 후 아래 경로로 환경변수 인식 여부를 확인할 수 있습니다.

```text
/api/health
```

예시:

```text
https://your-worker-subdomain.workers.dev/api/health
```

미국 주식/ETF가 정상 동작하려면 응답에 `hasFmpKey: true`가 보여야 합니다.
