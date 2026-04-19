# Stock Insight PWA

국내 주식 또는 미국 주식 한 종목을 검색해 아래 7개 지표와 최근 1년 분기 흐름을 보여주는 PWA입니다.

- PER
- PBR
- ROE
- ROIC
- 영업이익률
- 부채비율
- 배당수익률

국내 주식은 `OpenDART + 네이버 시세`, 미국 주식은 `SEC + FMP` 데이터를 사용합니다.

## 배포 구조

현재 프로젝트는 Cloudflare Workers Builds 기준입니다.

- Worker 진입점: `src/index.js`
- 정적 자산: `public/`
- API 로직: `functions/`

Wrangler가 `public/`을 정적 자산으로 배포하고, `/api/*` 요청은 Worker가 처리합니다.

## 환경변수

Cloudflare 프로젝트 환경변수에 아래 값을 넣어야 합니다.

- `OPEN_DART_API_KEY`
  - 국내 주식 공시 조회용
- `FMP_API_KEY`
  - 미국 주식 재무/가격 조회용
- `SEC_CONTACT_EMAIL`
  - SEC 요청 헤더에 넣을 이메일

## 데이터 소스

- 국내 주식 검색/재무: OpenDART
- 국내 주식 시세: 네이버 증권
- 미국 종목 검색: SEC `company_tickers_exchange.json`
- 미국 재무/가격: Financial Modeling Prep

## 주요 파일

- `public/index.html`: 화면 레이아웃
- `public/styles.css`: 스타일
- `public/app.js`: 검색, 상세 조회, 렌더링
- `public/service-worker.js`: PWA 캐시
- `src/index.js`: Worker 진입점
- `functions/api/master.js`: KR/US 마스터 목록 API
- `functions/api/stock.js`: 종목 상세 API
- `functions/api/health.js`: 환경변수 상태 확인 API
- `functions/_lib/kr.js`: 국내 주식 데이터 로직
- `functions/_lib/us.js`: 미국 주식 데이터 로직

## 확인 방법

배포 후 아래 경로로 환경변수 인식 여부를 확인할 수 있습니다.

```text
/api/health
```

예시:

```text
https://your-worker-subdomain.workers.dev/api/health
```

미국 주식이 정상 동작하려면 응답에 `hasFmpKey: true`가 보여야 합니다.
