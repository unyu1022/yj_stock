# Stock Insight PWA

국내 주식 또는 미국 주식 한 종목을 검색해 아래 7가지 지표와 최근 1년 분기 흐름을 확인하는 PWA입니다.

- PER
- PBR
- ROE
- ROIC
- 영업이익률
- 부채비율
- 배당수익률

이 버전은 Cloudflare Workers Builds와 정적 자산 배포를 사용해 실데이터를 조회합니다.

## 배포 방식

Cloudflare UI가 현재 `Workers Builds` 흐름으로 연결되고 있으므로, 이 저장소는 그 방식에 맞게 구성했습니다.

- Worker 진입점: `src/index.js`
- 정적 자산 디렉터리: `public/`
- API 로직: `functions/` 폴더 재사용

Wrangler는 `public` 폴더를 정적 자산으로 배포하고, `/api/*` 요청은 Worker가 직접 처리합니다.

## 필요한 환경변수

Cloudflare Workers 프로젝트 설정에서 아래 값을 추가하세요.

- `OPEN_DART_API_KEY`
  한국 OpenDART 인증키
- `ALPHA_VANTAGE_API_KEY`
  미국 주식 재무/가격 조회용 Alpha Vantage 키
- `SEC_CONTACT_EMAIL`
  SEC 요청 헤더용 연락 이메일

## 데이터 소스

- 국내 주식 검색/재무지표: OpenDART
- 미국 종목 검색: SEC `company_tickers_exchange.json`
- 미국 재무/가격 지표: Alpha Vantage

## 파일 구조

- `public/index.html`: 앱 레이아웃
- `public/styles.css`: 모바일 우선 스타일
- `public/app.js`: 검색, 상세 조회, 전망 렌더링
- `src/index.js`: Worker 진입점
- `functions/api/search.js`: 종목 검색 API
- `functions/api/stock.js`: 종목 상세 지표 API
- `functions/api/health.js`: 환경변수 상태 확인 API
- `functions/_lib/kr.js`: OpenDART 연동
- `functions/_lib/us.js`: SEC + Alpha Vantage 연동
- `public/service-worker.js`: PWA 캐시

## 로컬 정적 확인

정적 파일이 열리는지만 간단히 보려면 아래 명령으로 확인할 수 있습니다.

```powershell
Set-Location "C:\Users\kanzi\OneDrive\Desktop\stock"
& "C:\Users\kanzi\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173
```

다만 이 방식은 Worker를 실행하지 못하므로 실데이터 API까지는 확인되지 않습니다.

## 배포 후 점검

배포 후 아래 엔드포인트를 열어 설정 여부를 확인하세요.

```text
/api/health
```

예:

```text
https://your-worker-subdomain.workers.dev/api/health
```

최근에는 Cloudflare 대시보드에서 환경변수 수정 후 재배포 검증을 위해 커밋 기반 재빌드를 함께 사용하고 있습니다.
