---
title: Nginx Worker Connection 고갈로 발생한 장애, Rate Limit으로 어떻게 대응했을까?
description: 비정상 대량 요청으로 발생한 Nginx Worker Connection 고갈 장애를 분석하고, Rate Limit과 CloudWatch 모니터링으로 대응한 경험을 공유합니다.
date: 2026-10-27
author: 이효린
category: DevOps
tags: [AWS, Nginx, Rate Limit, CloudWatch, Reliability]
featured: false
---

안녕하세요. NeedU 인프라팀 이효린입니다!

AI 선물 추천 서비스 NeedU를 운영하던 중, 특정 API에 비정상적인 대량 요청이 집중되면서 HTTP 500 오류가 발생했습니다.

처음에는 Backend 애플리케이션에서 문제가 발생했다고 생각했습니다. 그러나 Spring Boot 로그에서는 해당 오류에 대응하는 예외를 찾을 수 없었고, Nginx Error Log에서 `worker_connections are not enough while connecting to upstream`이라는 메시지를 확인했습니다.

당시 최대 요청량은 **1,773 RPS**였습니다. Nginx가 Backend와 연결을 생성하는 과정에서 Worker Connection이 고갈된 것이 직접적인 장애 원인이었습니다.

이후 Worker Connection 한도를 조정하고 API별 Rate Limit을 적용했습니다. CloudWatch 모니터링과 경보 체계도 개선했습니다.

며칠 뒤 동일한 클라이언트에서 **최대 5,141 RPS**의 요청이 다시 발생했습니다. 이번에는 Nginx가 약 **98만 건의 요청을 HTTP 429로 제한**했고, 관측 구간에서 기존의 Worker Connection 고갈 오류는 다시 확인되지 않았습니다.

이번 글에서는 장애 원인을 어떻게 분석했는지, 여러 대응 방법 중 Nginx Rate Limit을 선택한 이유는 무엇인지, 그리고 실제 운영 지표를 통해 개선 효과를 어떻게 검증했는지 공유하려고 합니다.

---

## 1. 장애 발생: CPU는 정상인데 HTTP 500이 발생했다

### 1.1 운영 환경과 장애 상황

당시 NeedU는 하나의 EC2 인스턴스에서 Nginx를 Reverse Proxy로 사용하고 있었습니다. Frontend(Next.js), Backend(Spring Boot), AI Server(FastAPI)를 각각 실행하고, Nginx가 요청 경로에 따라 적절한 서비스로 트래픽을 전달하는 구조였습니다.

```text
                   Client
                      |
                    HTTPS
                      |
                      v
                 Nginx (EC2)
                      |
          +-----------+-----------+
          |           |           |
          v           v           v
       Frontend    Backend    AI Server
        Next.js   Spring Boot   FastAPI
```

이 구조에서 Nginx는 모든 외부 요청이 거치는 공통 진입점입니다. 따라서 하나의 API에 요청이 집중되더라도 Nginx의 Connection 자원을 함께 사용하게 됩니다.

2026년 9월 29일, CSRF 토큰 발급 API인 `GET /api/v1/auth/csrf`에 비정상적으로 많은 요청이 발생했습니다. Nginx Access Log를 분석한 결과, 동일한 클라이언트 IP에서 약 5분 동안 **89,587건**의 요청이 기록됐습니다.

| 항목 | 확인 결과 |
| --- | --- |
| 발생 시각 | 2026-09-29 21:12~21:16 KST |
| 요청 대상 | `GET /api/v1/auth/csrf` |
| 요청 발생지 | 동일 클라이언트 IP |
| 요청량 | 89,587건 |
| 최대 분당 요청량 | 69,375건 |
| 최대 초당 요청량 | 1,773 RPS |
| 장애 현상 | 일부 HTTP 500 응답 |

특히 21:14에만 69,375건의 요청이 발생했습니다. 해당 구간을 초 단위로 다시 확인했을 때 **21:14:53 KST에 1,773 RPS**를 기록했으며, 여러 초에 걸쳐 1,000 RPS 이상의 요청이 반복됐습니다.

이는 단순한 순간적인 트래픽 증가가 아니라, 특정 API에 지속적으로 고빈도 요청이 유입된 상황이었습니다.

### 1.2 서버 자원 지표에서는 문제가 보이지 않았다

장애 당시 CloudWatch 대시보드를 확인했지만, CPU 사용률은 약 25~26%였고 Service Health 지표도 정상으로 표시됐습니다.

![2026년 9월 29일 장애 당시 CloudWatch 대시보드](/assets/images/posts/nginx-rate-limit/nginx-before.png)


CPU나 메모리가 부족해서 발생한 장애라면 서버 자원 사용률이 크게 증가했을 가능성이 있습니다. 하지만 당시에는 그런 현상이 뚜렷하게 나타나지 않았습니다.

더 큰 문제는 Nginx 요청량과 HTTP 오류, Worker Connection 고갈 여부를 확인할 수 있는 지표가 부족했다는 점입니다. 대시보드의 Nginx 관련 패널에는 해당 시간 범위의 데이터가 표시되지 않았습니다.

이는 요청이 없었다는 뜻이 아니라, **실제 요청 처리 상태를 관측할 수 없었다는 의미**였습니다.

따라서 CPU와 Health Check만으로는 장애 원인을 판단하기 어려웠고, 요청이 지나가는 각 계층의 로그를 직접 확인해야 했습니다.

---

## 2. 로그를 통해 장애 원인을 좁히다

### 2.1 Backend가 아니라 Nginx에서 발생한 오류

HTTP 500 오류가 발생했기 때문에 가장 먼저 Spring Boot 로그를 확인했습니다. 하지만 장애 시간대에 Nginx에서 관측된 HTTP 500 응답과 직접 대응되는 애플리케이션 예외는 확인되지 않았습니다.

물론 Backend 로그에 예외가 없다는 사실만으로 애플리케이션이 정상이라고 단정할 수는 없습니다. 다만 요청이 Backend에 도달하기 전에 실패했을 가능성이 있었기 때문에 Nginx Error Log를 확인했습니다.

그 결과 다음 메시지가 반복적으로 발생하고 있었습니다.

```text
worker_connections are not enough while connecting to upstream
```

핵심은 `while connecting to upstream`입니다.

Nginx가 외부 요청을 받은 후 Spring Boot Backend로 전달하기 위해 Upstream Connection을 생성하려 했지만, 사용할 수 있는 Worker Connection이 부족해 연결을 생성하지 못했다는 의미입니다.

당시 설정은 다음과 같았습니다.

```nginx
worker_processes auto;

events {
    worker_connections 768;
}
```

`worker_processes auto`는 CPU 환경에 따라 Worker Process 수를 자동으로 결정하는 설정이며, `worker_connections 768`은 **각 Worker Process가 동시에 사용할 수 있는 Connection 수의 상한**입니다.

### 2.2 `worker_connections`는 RPS와 다르다

여기서 중요한 점은 `worker_connections`와 RPS가 서로 다른 개념이라는 것입니다.

`worker_connections=768`이라고 해서 초당 최대 768건의 요청만 처리할 수 있다는 뜻은 아닙니다. RPS는 초당 요청 수이고, Worker Connection은 특정 시점에 유지되는 연결 수를 제한합니다.

Nginx가 Reverse Proxy로 동작할 때는 클라이언트와의 연결뿐 아니라 Backend와의 Upstream Connection도 사용합니다.

```text
Client
   |
   | Client Connection
   v
Nginx Worker
   |
   | Upstream Connection
   v
Spring Boot Backend
```

실제로 사용되는 Connection 수는 Keep-Alive 설정, Upstream 응답 시간, 동시 요청 수, Worker Process 수 등에 영향을 받습니다.

예를 들어 Backend의 응답이 늦어지면 Upstream Connection이 더 오래 유지될 수 있습니다. 요청이 빠르게 증가하는 상황에서는 사용 중인 연결이 해제되기 전에 새로운 연결이 계속 필요해질 수 있습니다.

이번 장애에서도 특정 클라이언트가 CSRF API를 반복 호출하면서 Nginx의 Connection 자원이 소모됐고, 결국 Backend와 연결을 생성하는 단계에서 한도 부족 오류가 발생했습니다.

즉, 직접적인 장애 원인은 **Nginx Worker Connection 고갈로 인한 Upstream 연결 실패**였습니다.

하지만 여기서 Connection 한도만 늘리는 것으로 충분할까요?

---

## 3. Connection 증설과 Rate Limit을 함께 선택한 이유

장애 발생 이후 가장 먼저 고려한 방법은 `worker_connections` 값을 늘리는 것이었습니다. 기존 한도가 768이었기 때문에 이를 상향하면 동시에 유지할 수 있는 연결 수에 여유가 생깁니다.

그러나 이번 장애는 정상적인 사용자 증가가 아니라 특정 클라이언트의 비정상적인 고빈도 요청으로 시작됐습니다. 연결 한도를 늘리더라도 요청량이 계속 증가한다면 같은 문제가 반복될 수 있습니다.

따라서 연결 처리 용량을 확보하는 것과 별개로, **특정 클라이언트가 공유 자원을 과도하게 사용하지 못하도록 제한하는 방법**이 필요했습니다.

검토한 방법은 다음과 같습니다.

| 대응 방법 | 장점 | 한계 |
| --- | --- | --- |
| Worker Connection 증설 | 연결 처리 여유 확보 | 비정상 요청 자체는 제한하지 못함 |
| 특정 IP 차단 | 해당 요청 발생지 차단 | NAT 환경의 정상 사용자에게 영향 가능 |
| Backend Rate Limit | 인증 정보와 사용자별 제어 가능 | 요청이 이미 Nginx 자원을 사용함 |
| Nginx Rate Limit | Backend 전달 전에 요청 제한 | 정상적인 순간 요청을 고려해야 함 |

특정 IP를 차단하는 방법도 있었지만, 여러 사용자가 하나의 공인 IP를 공유하는 환경에서는 정상 사용자까지 차단될 가능성이 있었습니다.

Backend에서 Rate Limit을 적용하는 방법 역시 고려할 수 있습니다. 하지만 이번 장애는 Backend에 요청이 전달되기 전 Nginx에서 발생했습니다. 따라서 Backend에서 요청을 거절하더라도 그 과정까지 Nginx의 연결 자원이 사용될 수 있습니다.

반면 Nginx Rate Limit은 요청을 Upstream으로 전달하기 전에 검사하고 거절할 수 있습니다.

이러한 이유로 **Worker Connection 증설과 Nginx Rate Limit을 함께 적용**하기로 했습니다. Connection 증설은 처리 여유를 확보하기 위한 조치이고, Rate Limit은 비정상적인 요청이 자원을 과도하게 점유하지 못하도록 보호하는 조치입니다.

### 3.1 Worker Connection 한도 상향

기존 설정의 `worker_connections`를 768에서 4096으로 변경하고, Worker Process의 File Descriptor 한도도 명시했습니다.

```nginx
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
}
```

`worker_connections`는 Worker Process별 Connection 상한을 지정합니다. `worker_rlimit_nofile`은 Nginx Worker가 열 수 있는 File Descriptor 한도를 설정하는 지시어입니다.

Nginx는 네트워크 연결을 처리할 때도 File Descriptor를 사용하기 때문에, Connection 한도만 높이는 것이 아니라 운영체제의 파일 디스크립터 제한도 함께 고려해야 합니다.

설정 변경 후에는 문법을 검증하고 Reload를 수행했습니다.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

다만 Connection 한도 상향만으로는 비정상 요청의 유입을 막을 수 없으므로, 다음 단계에서 Rate Limit을 적용했습니다.

### 3.2 API 특성에 따라 Rate Limit 분리

모든 API에 동일한 제한을 적용하는 대신, 일반 API와 CSRF 토큰 발급 API의 호출 특성을 구분했습니다.

일반 API에는 IP별 평균 10r/s와 `burst=20`을 적용하고, 장애 대상이었던 CSRF API에는 더 엄격한 2r/s와 `burst=5`를 적용하는 방식입니다.

```nginx
# http 컨텍스트
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=csrf:10m rate=2r/s;
```

```nginx
# 일반 API location
limit_req zone=api burst=20 nodelay;
```

```nginx
# CSRF API location
limit_req zone=csrf burst=5 nodelay;
```

| 구분 | 일반 API | CSRF API |
| --- | --- | --- |
| 제한 기준 | 클라이언트 IP | 클라이언트 IP |
| Rate | 10r/s | 2r/s |
| Burst | 20 | 5 |
| 적용 대상 | `/api/` | `/api/v1/auth/csrf` |

`$binary_remote_addr`는 클라이언트 IP를 기준으로 요청을 구분합니다. `rate=10r/s`는 동일 IP의 평균 요청 허용 속도를 초당 10건으로 제한합니다.

여기서 `burst=20`은 초당 20건을 추가로 허용한다는 의미가 아닙니다. 설정한 요청 속도를 일시적으로 초과하는 요청에 대해 허용 가능한 초과 범위를 지정하는 값입니다. `nodelay`는 해당 범위 내에서 허용된 요청을 지연시키지 않고 처리하도록 합니다.

이 설정을 사용하면 정상적인 서비스 이용 과정에서 발생하는 짧은 요청 집중은 어느 정도 허용하면서, 지속적으로 높은 빈도의 요청이 유입될 때는 초과 요청을 제한할 수 있습니다.

CSRF API에는 일반 API보다 낮은 제한을 적용했습니다. CSRF 토큰 발급은 일반적인 사용 흐름에서 짧은 시간에 수천 번 반복 호출될 필요가 적기 때문입니다.

다만 IP 기반 Rate Limit은 동일 공인 IP를 공유하는 정상 사용자에게 영향을 줄 수 있습니다. 따라서 설정값이 적절한지는 실제 호출 패턴과 429 응답을 바탕으로 지속적으로 확인해야 합니다.

### 3.3 HTTP 429 응답과 Nginx 설정 시 주의할 점

Rate Limit으로 요청이 거절되면 Backend까지 전달되지 않습니다. 이번 운영 환경에서는 제한된 요청이 HTTP `429 Too Many Requests`로 기록되는 것을 확인했습니다.

Nginx `limit_req`의 기본 거절 상태 코드는 503이므로, 429를 반환하려면 다음 설정이 필요합니다.

```nginx
limit_req_status 429;
```

또한 Nginx의 `location` 선택 규칙도 고려해야 합니다. `/api/`와 `/api/v1/auth/csrf`처럼 서로 다른 `location`에서 Rate Limit을 설정했다면, 실제 요청에 어떤 `location`이 선택되는지 확인해야 합니다.

특히 더 구체적인 `location`이 선택됐다고 해서 다른 `location`의 제한이 자동으로 함께 적용되는 것은 아닙니다. 따라서 Endpoint별 정책이 의도한 대로 적용되는지 실제 요청과 Access Log를 통해 검증하는 과정이 필요합니다.

---

## 4. 장애를 감지할 수 있도록 CloudWatch 모니터링 개선

Rate Limit을 적용한 뒤에는 모니터링도 개선했습니다.

기존 대시보드에서는 CPU, Memory, Disk, Service Health와 같은 서버 상태를 주로 확인했습니다. 그러나 이번 장애처럼 서버 자원 사용률이 높지 않아도 Nginx에서 요청 처리가 실패할 수 있었습니다.

따라서 서버가 실행 중인지 확인하는 것뿐 아니라, **Nginx가 실제 요청을 정상적으로 처리하고 있는지**를 확인할 수 있도록 지표를 추가했습니다.

### 4.1 Nginx 로그 기반 지표 추가

CloudWatch Logs에 수집되는 Nginx Access Log와 Error Log를 기반으로 Metric Filter를 구성했습니다.

| 지표 | 확인 목적 |
| --- | --- |
| Nginx Request Count | 전체 요청량 증가 감지 |
| Nginx 4xx Count | 클라이언트 오류 및 Rate Limit 응답 감지 |
| Nginx 5xx Count | 서버 측 요청 처리 실패 감지 |
| Worker Connection Exhaustion | Nginx 연결 자원 부족 오류 감지 |
| Backend ERROR Count | 애플리케이션 오류 증가 여부 확인 |

특히 `worker_connections are not enough` 메시지를 별도 관측 대상으로 추가했습니다.

이를 통해 요청량이 급증했을 때 단순히 CPU 사용률만 보는 것이 아니라, HTTP 오류가 증가했는지, Nginx Connection 고갈이 발생했는지까지 같은 대시보드에서 비교할 수 있도록 했습니다.

![2026년 10월 1일 개선 후 후속 대량 요청 당시 CloudWatch 대시보드](/assets/images/posts/nginx-rate-limit/nginx-after.png)

개선 후 대시보드에서는 10월 1일 15시경 요청량과 4xx 응답이 크게 증가한 모습을 확인할 수 있었습니다. 반면 표시된 5xx와 Worker Connection Exhaustion 지표는 해당 관측 구간에서 0으로 나타났습니다.

CPU 사용률 역시 그래프상 약 10~22% 수준이었습니다. 이 결과는 CPU 사용률만으로는 대량 요청의 발생 여부나 Rate Limit 동작 상태를 판단하기 어렵다는 점을 다시 보여줬습니다.

### 4.2 CloudWatch Alarm과 Discord 알림 연동

대시보드에 지표를 추가하는 것만으로는 충분하지 않았습니다. 운영자가 계속 대시보드를 확인하고 있지 않더라도 이상 징후를 발견할 수 있어야 했기 때문입니다.

이에 Nginx 요청량과 4xx 응답이 설정한 기준을 초과하면 CloudWatch Alarm이 발생하도록 구성하고, Discord로 경보를 전달하도록 했습니다.

![2026년 10월 1일 약 15:06 KST에 전달된 Nginx 4xx 급증 경보](/assets/images/posts/nginx-rate-limit/nginx-alarm.png)

10월 1일 실제로 전달된 경보에서는 `Nginx4xxCount`가 임계값 20을 초과한 **43,556**으로 관측됐고, 경보 상태가 `OK`에서 `ALARM`으로 변경됐습니다.

또한 경보에는 초기 대응 가이드를 포함했습니다. 401/403은 인증 및 권한 문제, 404는 잘못된 경로 요청, 429는 Rate Limit 동작 여부를 우선 확인하도록 했습니다.

특정 IP나 Endpoint에 요청이 집중되는 경우에는 Access Log를 통해 반복 요청 여부를 분석하고, 필요하다면 Rate Limit 정책을 조정할 수 있도록 했습니다.

이렇게 모니터링을 개선하면서 단순히 서버 상태를 확인하는 수준을 넘어, **비정상적인 요청이 발생했을 때 관련 지표와 초기 대응 절차를 함께 전달받는 구조**를 마련했습니다.

---

## 5. 개선 효과 검증: 더 높은 요청량이 다시 발생했다

### 5.1 최대 5,141 RPS의 후속 요청

2026년 10월 1일 15시경, 9월 29일 장애를 유발했던 클라이언트 IP에서 다시 대량 요청이 발생했습니다.

이번에는 CSRF 토큰 발급 API뿐 아니라 선물 추천 조회 API에도 요청이 집중됐습니다. Nginx Access Log를 분석한 결과, **15:05:58 KST에 최대 5,141 RPS**를 기록했습니다.

이는 최초 장애 당시 최대 요청량인 1,773 RPS보다 약 2.9배 높은 수치입니다.

다만 여기서 말하는 RPS는 Nginx Access Log에 기록된 요청 수입니다. Rate Limit에 의해 거절된 HTTP 429 응답도 포함되므로, Backend가 실제로 5,141 RPS를 처리했다는 의미는 아닙니다.

### 5.2 약 98만 건의 요청이 HTTP 429로 제한되다

15:04~15:16 KST 구간의 Access Log를 분석한 결과, 총 **980,785건의 HTTP 429 응답**이 확인됐습니다.

주요 Endpoint별 결과는 다음과 같습니다.

| Endpoint | HTTP 200 | HTTP 429 |
| --- | ---: | ---: |
| CSRF 토큰 발급 | 994 | 568,215 |
| 선물 추천 조회 | 466 | 412,562 |
| **합계** | **1,460** | **980,777** |

나머지 429 응답 8건은 다른 API 경로에서 발생했습니다. 또한 같은 분석 구간에서 HTTP 499 응답 18건이 확인됐습니다.

HTTP 429 응답 980,785건은 모두 동일한 클라이언트 IP에서 발생했습니다.

이는 다수의 정상 사용자가 동시에 증가한 트래픽이라기보다, 특정 클라이언트에서 집중적으로 발생한 요청이었음을 보여줍니다.

중요한 점은 대량 요청이 Nginx에 도달했더라도, Rate Limit이 적용된 경로에서는 초과 요청을 Backend로 전달하지 않고 Nginx에서 거절했다는 것입니다.

### 5.3 Worker Connection 고갈은 재발하지 않았을까?

9월 29일과 10월 1일의 결과를 비교하면 다음과 같습니다.

| 항목 | 9월 29일 | 10월 1일 |
| --- | --- | --- |
| 최대 요청량 | 1,773 RPS | 5,141 RPS |
| Worker Connection | 768 | 4096 |
| Nginx Rate Limit | 미적용 | 적용 |
| 주요 오류 | HTTP 500 | HTTP 429 |
| Connection 고갈 | Error Log에서 확인 | 관측 구간에서 재발 미확인 |
| 모니터링 | Nginx 지표 부족 | 요청량·오류·Connection 지표 확인 |

10월 1일 CloudWatch 대시보드에서는 요청량과 4xx 응답이 크게 증가했지만, 표시된 Worker Connection Exhaustion과 5xx 지표는 0이었습니다.

따라서 관측한 구간에서는 최초 장애와 동일한 Connection 고갈 문제가 다시 발생했다는 근거를 확인하지 못했습니다.

다만 이 결과만으로 정상 사용자에게 영향이 전혀 없었다고 단정할 수는 없습니다. 이를 검증하려면 Backend에 실제 전달된 요청량, 응답 지연, 애플리케이션 오류, 정상 사용자의 429 응답 여부 등을 추가로 확인해야 합니다.

이번 검증에서 확인할 수 있었던 것은 **더 높은 요청량이 유입된 상황에서도 Nginx Rate Limit이 초과 요청을 제한했고, 기존 Connection 고갈 오류가 관측 자료에서 재발하지 않았다는 사실**입니다.

### 5.4 경보 체계도 실제로 동작했다

10월 1일에는 대량 요청이 두 차례 집중됐고, CloudWatch Alarm도 이에 맞춰 발생했습니다.

| 시각(KST) | Nginx 요청량 지표 | Nginx 4xx 지표 | 경보 상태 |
| --- | ---: | ---: | --- |
| 15:05 | 87,116 | 43,556 | 경보 발생 |
| 15:10 | 1 | 0 | 정상 복구 |
| 15:12 | 64,117 | 32,114 | 경보 재발생 |
| 15:16 | 1 | 0 | 정상 복구 |

요청량이 증가했을 때 경보가 발생하고, 요청량이 감소한 이후 정상 상태로 복구되는 흐름을 확인했습니다.

이는 단순히 지표를 추가하는 데 그치지 않고, 실제 운영 상황에서 이상 징후를 감지하고 알리는 체계가 동작했음을 보여줬습니다.

---

## 6. 이번 장애를 통해 배운 점

이번 장애에서 가장 중요했던 것은 단순히 Nginx 설정값을 늘린 것이 아니었습니다.

처음에는 HTTP 500 오류를 보고 Backend 문제를 의심했지만, Spring Boot 로그와 Nginx Error Log를 함께 확인하면서 실제 장애 지점이 Upstream 연결 생성 단계라는 사실을 발견했습니다. 이를 통해 **HTTP 상태 코드만으로 장애 원인을 단정하지 않고 요청이 지나가는 각 계층을 확인하는 것**이 중요하다는 점을 배웠습니다.

또한 처리 용량을 늘리는 것과 공유 자원을 보호하는 것은 서로 다른 문제라는 사실을 확인했습니다. `worker_connections`를 상향하면 동시에 사용할 수 있는 연결 수는 증가하지만, 특정 클라이언트가 지속적으로 비정상 요청을 보내는 상황 자체를 막지는 못합니다. 따라서 Connection 증설과 Rate Limit을 함께 적용해야 했습니다.

모니터링 측면에서도 개선할 점이 있었습니다. 장애 당시 CPU와 Service Health는 정상으로 표시됐지만 실제 요청은 실패하고 있었습니다. 이후 Nginx 요청량, 4xx/5xx, Worker Connection 고갈 지표를 추가하면서 서버 상태뿐 아니라 실제 요청 처리 상태까지 관측할 수 있도록 했습니다.

마지막으로 설정 변경 자체보다 **변경 이후 실제로 어떤 결과가 나타났는지 검증하는 과정**이 중요하다는 점을 배웠습니다.

10월 1일에는 최초 장애보다 높은 최대 5,141 RPS의 요청이 발생했지만, 약 98만 건의 초과 요청이 HTTP 429로 제한됐고, 관측 구간에서 Worker Connection 고갈 오류는 재발하지 않았습니다. CloudWatch Alarm도 실제 요청 증가에 맞춰 동작했습니다.

물론 정상 사용자에게 미친 영향이나 Backend 실제 처리량처럼 추가로 검증해야 할 부분은 남아 있습니다. 이러한 한계 역시 운영 결과와 구분해 기록하는 것이 필요하다고 생각합니다.

이번 경험을 통해 안정적인 서비스 운영은 단순히 서버 자원을 늘리는 것으로 완성되지 않는다는 점을 배웠습니다. **장애가 발생한 계층을 정확히 파악하고, 공유 자원을 보호하는 정책을 적용하며, 개선 효과를 실제 지표로 검증하는 과정**이 함께 이루어져야 합니다.

---

## 참고 자료

- [NGINX: ngx_http_limit_req_module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [NGINX: Core Functionality](https://nginx.org/en/docs/ngx_core_module.html)
- [AWS CloudWatch Logs: Creating Metrics from Log Events](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html)
- [AWS CloudWatch: Using Amazon CloudWatch Alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)