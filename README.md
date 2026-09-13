# AeroSense 백엔드 (기상청 API 프록시)

브라우저가 기상청 API를 직접 호출할 수 없어서(인증키 노출, CORS), 이 작은 서버가
대신 기상청에 요청하고, 결과를 aerosense.html이 바로 쓸 수 있는 격자 JSON으로 바꿔줍니다.

## 1. 준비물
- Node.js 18 이상 설치되어 있어야 함 (`node -v`로 확인)
- 기상청 API허브(https://apihub.kma.go.kr)에서 발급받은 인증키

## 2. 설치 및 실행

```bash
cd aerosense-server
npm install
```

인증키를 환경변수로 설정한 뒤 실행합니다.

macOS / Linux:
```bash
export KMA_AUTH_KEY=발급받은인증키
node server.js
```

Windows (cmd):
```bash
set KMA_AUTH_KEY=발급받은인증키
node server.js
```

정상 실행되면 이렇게 뜹니다:
```
AeroSense backend listening on http://localhost:3787
KMA_AUTH_KEY set: true
```

## 3. 확인

브라우저에서 아래 주소를 열어 정상 응답이 오는지 확인하세요.
```
http://localhost:3787/api/health
```
`{"ok":true,"hasKey":true}` 가 나오면 정상입니다.

```
http://localhost:3787/api/live-grid
```
격자 데이터 JSON이 나오면 연동 준비 완료입니다. (첫 호출은 기상청 API 여러 개를
동시에 부르기 때문에 몇 초 걸릴 수 있어요.)

## 4. aerosense.html과 연결하기

1. aerosense.html을 브라우저로 엽니다.
2. 상단의 "데이터 연동 설정"에서 백엔드 URL에 `http://localhost:3787`을 입력합니다. (기본값으로 이미 들어있어요)
3. "실제 API 데이터 사용" 체크박스를 켭니다.
4. 경로를 다시 생성하면 시뮬레이션 대신 이 서버가 준 실제 데이터로 위험지수가 계산됩니다.
5. 서버가 꺼져 있거나 요청이 실패하면 자동으로 시뮬레이션 값으로 돌아가고, 로그에 "실데이터 연동 실패" 메시지가 남습니다.

## 5. 알아두어야 할 한계 (정직하게 밝혀두는 게 좋아요)

- **난기류**: 이번 버전은 SIGMET/AIRMET 특보에 난기류 관련 문구가 있는지로 근사치만 냅니다.
  더 정밀하게 하려면 "저고도 난류예측자료(NetCDF, KTG)"를 받아 파싱하는 작업이 추가로 필요해요
  (`server.js`의 TODO 주석 참고).
- **지형고도**: 아직 V-World 연동 전이라 기존 절차적 생성값을 그대로 씁니다.
- **WINTEM 파싱**: 기상청 문서만으로는 정확한 응답 포맷을 100% 확정할 수 없어서,
  `server.js`의 `fetchWintem()` 함수가 JSON과 텍스트 두 가지 경우를 모두 시도하도록 짜놨어요.
  실제 키로 호출해보고 응답 구조가 다르면 그 함수만 수정하면 됩니다.
