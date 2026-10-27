---
title: 46분의 쓰기 제한을 103초로: NeedU V1 → V2 Production Cutover 개선기
description: DNS 기반 수동 전환을 ALB와 GitHub Actions 기반 Cutover로 개선해, 쓰기 제한을 46분 이상에서 103초로 줄이고 V1에서 V2로 트래픽을 전환한 과정을 공유합니다.
date: 2026-10-27
author: 이소담
category: DevOps
tags: [AWS, Migration, DevOps, Reliability]
featured: false
---

안녕하세요. NeedU 인프라팀 이소담입니다!

최근 NeedU의 기존 EC2 기반 V1 환경을 ECS와 RDS 기반 V2 환경으로 전환했습니다.

새 인프라를 구성하는 일보다 어려웠던 것은 전환 순간을 설계하는 일이었습니다. 읽기 요청은 계속 처리하면서 두 데이터베이스의 정합성을 맞춰야 했고, 그사이 쓰기 요청이 제한되는 시간은 최대한 짧아야 했습니다. 문제가 생기면 바로 V1으로 돌아갈 수 있는 복구 경로도 필요했습니다.

첫 리허설의 결과는 꽤 충격적이었습니다. 쓰기 제한이 최소 46분 35초 동안 이어졌기 때문입니다. 이대로는 Production 전환을 진행하기 어렵다고 판단했고, 이후 6차례에 걸쳐 전환 구조와 실행 절차를 하나씩 바꿨습니다. 그 결과 최종 Production Cutover에서는 실제 AWS Rule 기준 쓰기 제한 시간을 최대 103초까지 줄일 수 있었습니다.

이 글에서는 46분이 넘던 시간을 어떻게 103초까지 줄였는지, 그 과정에서 어떤 선택을 했고 무엇을 확인했는지 이야기합니다.

- DNS 전환 대신 ALB Listener Rule을 선택한 이유
- 쓰기 정합성을 위해 짧은 Write Gate를 사용한 이유
- 사전 준비와 자동화로 제한 시간을 줄인 과정
- CloudWatch, CloudTrail, Grafana로 실제 전환을 검증한 방법
- 6차례의 리허설과 Production 전환에서 배운 점

---

## Cutover 성공 기준 정의

새로운 V2 환경이 정상 동작하는 것만 확인한다고 마이그레이션이 끝나는 것은 아니었습니다. 실제 요청이 V1에서 V2로 이동하는 동안 사용자가 얼마나 영향을 받았는지, 데이터는 빠짐없이 옮겨졌는지까지 확인해야 진짜 성공이라고 말할 수 있었습니다.

V2는 출시 약 14개월 뒤의 성장 규모를 기준으로 설계했습니다.

| 항목 | 설계 기준 |
| --- | ---: |
| MAU | 약 291,900명 |
| DAU | 약 72,975명 |
| Peak API Traffic | 약 101~122 RPS |
| Peak Write | 약 49 QPS |
| AI Inference Traffic | 약 4.87 RPS |
| 월간 가용성 목표 | 99% 이상 |

Cutover의 성공 조건은 이 설계 목표를 운영 지표로 확인할 수 있도록 정했습니다.

| 검증 영역 | 성공 조건 |
| --- | --- |
| 읽기 연속성 | 전환 전후 ALB 요청이 계속 유입되고 처리 대상이 V1에서 V2로 이동할 것 |
| 처리 용량 | V2 서비스별 Running Task 2개와 Healthy Target을 유지할 것 |
| 오류 | Target 5xx, Target 연결 오류, ALB 연결 거부가 발생하지 않을 것 |
| 쓰기 제한 | Write Gate를 120초 안에 해제할 것 |
| 데이터 | DMS Validation 오류가 없고 MySQL·PostgreSQL 검증을 통과할 것 |
| 복구 | Gate 해제 전에 실패하면 V1으로 되돌릴 수 있을 것 |

처음부터 이 기준을 정해 둔 덕분에 리허설을 반복할 때마다 무엇을 줄이고, 무엇을 자동화하고, 어떤 지표를 더 살펴봐야 할지 판단하기가 한결 쉬워졌습니다.

## 읽기 요청 유지와 Write Gate 적용

V1과 V2를 ALB에 미리 연결해 둔 뒤, 데이터 정합성이 필요한 짧은 구간에만 Write Gate를 적용하는 방식을 선택했습니다.

```text
V1·V2 Target 사전 연결
→ V1 100 / V2 0
→ Write Gate ON
→ DMS 중지 및 데이터 검증
→ V1 0 / V2 100
→ V2 Target Health 확인
→ Write Gate OFF
```

Write Gate가 켜져 있는 동안에도 읽기 요청은 V1에서 계속 처리하도록 했습니다. 쓰기 요청과 인증 Callback만 ALB 고정 응답으로 잠시 제한해 데이터의 기준점을 만든 뒤, DMS를 멈추고 최종 데이터 검증과 전환을 수행하는 방식입니다.

### Write Gate를 선택한 이유

전환 중 쓰기를 다루는 방법은 여러 가지였습니다.

| 방식 | 장점 | 이번 전환에서의 부담 |
| --- | --- | --- |
| 짧은 Write Gate | 구현이 단순하고 데이터 기준점이 명확함 | 제한 시간 동안 쓰기·인증 요청을 처리하지 못함 |
| Queue | 요청을 잃지 않고 전환 후 처리 가능 | 비동기 응답, 순서·중복·재시도·DLQ·멱등성 처리가 필요함 |
| Dual Write | 두 DB에 실시간으로 반영 가능 | 한쪽만 성공했을 때 정합성과 복구 처리가 복잡함 |
| ProxySQL | 쓰기 대상을 규칙으로 변경 가능 | 두 DB의 동기화와 진행 중인 트랜잭션은 별도로 다뤄야 함 |
| Transactional Outbox | DB 변경과 이벤트 발행을 원자적으로 처리 | 모든 쓰기 경로와 Relay·Consumer를 새로 구성해야 함 |

Queue와 Outbox는 지속적으로 운영할 데이터 파이프라인이라면 충분히 검토할 만한 선택지입니다. 하지만 이번 작업은 한 번의 Cutover였습니다. 이를 위해 즉시 처리하던 API를 비동기로 바꾸거나 모든 쓰기 경로를 수정하면, 마이그레이션보다 더 큰 변경을 만드는 셈이었습니다.

NeedU는 월간 99% SLO와 데이터 정합성을 함께 고려해 **DMS CDC와 120초 이내의 Write Gate**를 선택했습니다. 제한 시간을 짧고 예측 가능하게 만드는 것이 핵심 과제가 됐습니다.

### 103초가 오류 예산에 미치는 영향

30일을 720시간으로 보면 99% SLO의 월간 오류 예산은 7시간 12분, 즉 25,920초입니다.

```text
720시간 × 1% = 7.2시간 = 25,920초
```

최종 Cutover의 최대 Write Gate 유지 시간 103초를 전체 서비스 중단으로 보수적으로 계산해도 월간 오류 예산의 약 0.4%입니다.

```text
103초 ÷ 25,920초 × 100 ≈ 0.4%
```

실제로는 읽기 요청이 계속 처리됐고 쓰기와 인증만 제한됐습니다. 따라서 이 계산은 실제 사용자 영향보다 보수적입니다.

## 1차: 46분이 넘은 쓰기 제한

첫 Staging 리허설에서는 다음 작업을 순서대로 수행했습니다.

1. Nginx에서 쓰기 요청 제한
2. PostgreSQL 최종 Dump와 Restore
3. DMS 중지
4. ECS 기동과 Health Check
5. DNS 변경
6. Smoke Test

돌이켜 보면 문제는 분명했습니다. 절차 대부분을 Write Freeze 이후에 시작하고 있었습니다. 그 결과 쓰기 제한 시간은 최소 46분 35초까지 길어졌습니다. DNS 전파 시간도 정확히 제어하기 어려웠고, 쓰기 제한과 트래픽 전환이 하나의 긴 절차로 묶여 있었습니다.

첫 리허설을 마치고 내린 결론은 간단했습니다.

> 전환 시점에 꼭 해야 하는 작업과 미리 끝낼 수 있는 작업을 분리해야 한다.

## 2차: DNS에서 ALB Listener Rule로 전환

2차부터는 V1과 V2 Target을 같은 ALB에 연결하고 Listener Rule의 Target Weight를 바꾸는 방식으로 변경했습니다.

```text
전환 전: V1 100 / V2 0
전환 후: V1 0 / V2 100
```

이제 DNS 캐시나 전파를 기다릴 필요 없이 AWS 제어 영역에서 전환 시점을 명확하게 확인할 수 있었습니다. Write Gate도 Nginx가 아닌 ALB Rule로 분리했습니다. 덕분에 트래픽의 목적지를 바꾸는 작업과 쓰기를 제한하는 작업을 각각 독립적으로 실행하고 복구할 수 있게 됐습니다.

2차 Write Gate는 630초 동안 유지됐습니다. 1차보다 크게 줄었지만 여전히 수동 확인과 순차 실행이 긴 시간을 차지했습니다.

## 3차: Cutover 사전 작업 분리

3차에서는 아래 작업을 Write Gate 이전으로 옮겼습니다.

- PostgreSQL 사전 복원
- V2 ECS Task 사전 기동
- ALB Target Health 확인
- V2 Smoke Test

Gate가 켜진 뒤에는 데이터의 최종 기준점을 만들기 위한 작업만 남겼습니다.

```text
Write Gate ON
→ 활성 트랜잭션 종료 확인
→ DMS 중지
→ 최종 데이터 확인
→ ALB 전환
→ V2 Health 확인
→ Write Gate OFF
```

그 결과 쓰기 제한은 327~349초로 줄었고, Cutover 전 Smoke Test 7개도 모두 통과했습니다. 사전 준비의 효과는 분명했습니다. 다만 사람이 직접 명령을 실행하고 결과를 확인하다 보니 소요 시간이 매번 달라지는 문제는 남아 있었습니다.

## 4차: GitHub Actions 기반 자동화

4차에서는 Cutover 절차를 GitHub Actions Workflow로 자동화했습니다.

- DMS 중지와 상태 확인
- 데이터 검증
- ALB Listener Rule 변경
- ECS와 Target Health 확인
- Write Gate 해제
- 실패 시 V1 복구

각 단계는 앞 단계의 성공을 확인한 뒤 실행되도록 구성했습니다. 사람이 여러 콘솔과 명령 사이를 오가며 판단하던 시간을 없애자 Staging의 쓰기 제한 시간이 59초까지 줄었습니다.

자동화하면서 느낀 점은, 목적이 단순히 실행 속도를 높이는 데만 있지 않다는 것이었습니다. 같은 조건을 같은 순서로 반복하고, 어디에서 실패했으며 복구가 실행됐는지를 기록으로 남길 수 있다는 점이 더 중요했습니다.

## 5차: Production에서 발견한 인증 설정 문제

5차는 자동화한 Workflow를 Production에 처음 적용한 실행이었습니다. 사전 검증 20개는 모두 통과했고 Cutover도 성공했지만, V1과 V2의 JWT 서명 키가 달라 일부 요청에서 401 응답이 발생했습니다.

인프라와 데이터가 모두 정상이어도 애플리케이션의 인증 설정이 다르면 사용자는 전환을 실패로 경험한다는 것을 직접 확인한 순간이었습니다. 이후 V2 Production의 JWT 설정을 V1과 일치시키고, 인증 관련 검증도 다시 점검했습니다.

5차의 Workflow 기준 Write Gate는 129초였습니다. 이 경험을 반영해 6차에서는 검증을 유지하면서 Cutover 단계의 대기와 실행 순서를 다듬었습니다.

## 6차: 103초의 최종 Production Cutover

최종 실행 전 Preflight 20개가 모두 통과했습니다. 여기에는 다음 항목이 포함됐습니다.

- ALB가 V1 100, V2 0 상태인지 확인
- V1과 V2 Target Health 확인
- FE·BE·AI의 Running Task가 각각 2개 이상인지 확인
- RDS MySQL과 PostgreSQL 상태 확인
- DMS Full Load와 Validation 상태 확인
- MySQL 주요 테이블 데이터 확인
- PostgreSQL Catalog, `vector(1024)` 타입과 HNSW Index 확인
- Write Gate가 비활성 상태인지 확인

실제 Cutover는 다음과 같이 진행됐습니다.

| 시각(KST) | 이벤트 |
| --- | --- |
| 15:53:37 | 일반 쓰기 Gate 생성 |
| 15:53:38 | 인증 Callback Gate 생성 |
| 15:53:49 | Gate의 HTTP 503 응답 확인 |
| 15:54:12~15:54:34 | DMS 중지 및 상태 확인 |
| 15:54:34~15:54:51 | 데이터 재검증과 V2 변환 작업 |
| 15:55:04 | Backend 트래픽을 V2로 전환 |
| 15:55:06 | Frontend 트래픽을 V2로 전환 |
| 15:55:08~15:55:12 | V2 Target Health 확인 |
| 15:55:19 | 일반 쓰기 Gate 삭제 |
| 15:55:21 | 인증 Callback Gate 삭제 |
| 15:55:22 | Gate 해제 확인 |

측정 위치에 따라 Gate 시간은 두 가지로 기록됐습니다.

| 측정 기준 | 일반 쓰기 | 인증 Callback |
| --- | ---: | ---: |
| Workflow가 HTTP 응답으로 확인한 구간 | 93초 | 93초 |
| CloudTrail의 Rule 생성·삭제 기록 | 102초 | 103초 |

Workflow의 93초는 Gate가 적용됐음을 HTTP로 확인한 순간부터 해제를 확인한 순간까지입니다. 실제 AWS Rule이 존재한 시간은 CloudTrail 기준 최대 103초입니다. 사용자 영향과 인프라 변경 시간을 혼동하지 않도록 최종 결과에서는 두 수치를 구분했습니다.

### 4차의 59초보다 최종 Cutover가 길어진 이유

여기까지 보면 한 가지 의문이 생깁니다. Staging 4차 리허설에서는 Write Gate가 59초였는데, 최종 Production에서는 최대 103초로 늘어났습니다.

결론부터 말하면 전환 과정이 느려진 것이 아니라, **Production에서 필요한 검증과 복구 절차를 더 촘촘하게 추가했기 때문**입니다. 4차 이후 Production Workflow에는 다음 단계가 보강됐습니다.

- Gate 생성 직후 실제 쓰기 요청이 503으로 차단되는지 확인
- 열려 있는 트랜잭션이 0인지 두 번 확인
- DMS 중지 직전 CDC 지연과 전체 테이블 Validation 상태 재검증
- DMS가 완전히 멈춘 뒤 대상 DB의 데이터를 다시 대조
- V2 전환에 필요한 사용자·데이터 변환 실행
- ALB 전환 후 Frontend와 Backend의 Healthy Target 수 재검증
- 중간 실패나 취소가 발생하면 V1으로 되돌리고 Gate를 해제하는 자동 복구 절차 추가

특히 DMS 중지 후 데이터 재검증과 V2 데이터 변환은 Gate가 켜진 상태에서 실행해야 합니다. Gate 시간을 줄이기 위해 이 단계를 생략하면 전환은 빨라지지만, 두 데이터베이스가 같은 기준점을 가졌다는 확신은 약해집니다.

Staging 4차의 목표가 자동화한 전환 흐름이 정상적으로 동작하는지 빠르게 확인하는 것이었다면, Production의 목표는 문제가 없는지 확인한 뒤에만 다음 단계로 넘어가고 실패 시 안전하게 V1으로 복구하는 것이었습니다. 따라서 59초와 103초의 차이는 성능 저하라기보다 **속도보다 안정성을 우선하며 확보한 검증 시간**으로 보는 것이 정확합니다.

그럼에도 실제 AWS Rule 유지 시간은 목표로 정한 120초 안에 들어왔습니다. 필요한 안전장치를 추가하면서도 사용자에게 영향을 주는 시간을 목표 범위 안에서 관리했습니다.

## 전환 연속성 검증

Workflow에 `success`가 표시됐다고 해서 사용자의 요청이 끊기지 않았다고 바로 결론 내릴 수는 없습니다. 그래서 CloudTrail로 실제 변경 시각을 확인하고, CloudWatch와 Grafana에서 전환 전후의 요청·Target·오류 지표를 함께 비교했습니다.

관측 구간은 15:48부터 16:01 KST까지였습니다.

### V1에서 V2로 이동한 요청 처리 대상

ALB에는 전체 2,727건의 요청이 들어왔고, 요청 수가 0인 1분 구간은 없었습니다. Backend와 Frontend가 전환된 15:55에도 265건의 요청이 기록됐습니다.

| 시각(KST) | ALB 요청 수 | V1 처리 | V2 Frontend | V2 Backend |
| --- | ---: | ---: | ---: | ---: |
| 15:54 | 242 | 242 | 0 | 0 |
| 15:55 | 265 | 67 | 12 | 87 |
| 15:56 | 301 | 0 | 20.5 | 130 |
| 15:57 | 368 | 0 | 37 | 147 |

전환 직전인 15:54에는 V1이 요청을 처리했습니다. 전환 시각이 포함된 15:55에는 V1과 V2 양쪽에 기록이 남았고, 15:56부터 V1은 0, V2 Frontend와 Backend는 계속 증가했습니다.

`RequestCountPerTarget`은 Target Group의 요청 수를 Healthy Target 수로 나눈 값이므로 세 열을 더해 전체 요청 수와 비교해서는 안 됩니다. 여기서는 요청의 절대 합계가 아니라 처리 대상이 이동한 흐름을 확인하는 데 사용했습니다.

### Target Health와 실행 용량 유지

| 대상 | Healthy 최솟값 | Unhealthy 최댓값 |
| --- | ---: | ---: |
| V1 | 1 | 0 |
| V2 Frontend | 2 | 0 |
| V2 Backend | 2 | 0 |

FE·BE·AI ECS 서비스의 Running Task도 각각 최소 2개를 유지했습니다. 같은 시간대에 서비스를 갱신하거나 Task를 중지한 이벤트는 없었습니다.

### 전환 구간의 Target 오류

| 지표 | 결과 |
| --- | --- |
| V1·V2 Target 5xx | 관측되지 않음 |
| Target 연결 오류 | 관측되지 않음 |
| ALB 연결 거부 | 관측되지 않음 |
| V1·V2 Unhealthy Target | 0개 |

15:53에는 Write Gate 생성·검증과 함께 ALB 5xx와 고정 응답이 각각 1건 기록됐습니다. 두 지표는 Backend와 Frontend를 전환한 15:55보다 앞선 시각에 발생했습니다. 전환 이후에는 Target 5xx, Target 연결 오류, ALB 연결 거부가 관측되지 않았습니다.

### 전환 직후의 응답시간 상승

| 시각(KST) | V1 p95 | V2 Frontend p95 | V2 Backend p95 |
| --- | ---: | ---: | ---: |
| 15:54 | 8.1ms | - | - |
| 15:55 | 19.4ms | 416.1ms | 50.4ms |
| 15:56 | - | 383.7ms | 39.1ms |
| 15:57 | - | 71.4ms | 25.4ms |

V2 Frontend p95는 전환 직후 416.1ms까지 올랐다가 2분 뒤 71.4ms로 낮아졌습니다. 오류 지표와 Target Health에는 이상이 없었지만, 성공 여부만 확인했다면 놓쳤을 변화입니다. Cutover 이후 짧은 안정화 구간을 관측해야 하는 이유를 보여줬습니다.

![Production ALB 요청률](/assets/images/posts/v1-v2-cutover/alb-rps.png)

![Production ALB Target 응답시간 p95](/assets/images/posts/v1-v2-cutover/alb-target-response-time.png)

![Production ECS Running Task](/assets/images/posts/v1-v2-cutover/ecs-running-task.png)

![Production ALB Target Health](/assets/images/posts/v1-v2-cutover/alb-target-health.png)

## 데이터 정합성 검증

트래픽 전환이 정상이어도 데이터가 맞지 않으면 마이그레이션은 성공이 아닙니다. MySQL은 AWS DMS Full Load와 CDC로 이전했고, PostgreSQL은 Dump·Restore와 Catalog 적재를 사용했습니다.

최종 Preflight와 Cutover에서 다음 결과를 확인했습니다.

| 데이터베이스 | 이전 방식 | 검증 결과 |
| --- | --- | --- |
| MySQL | DMS Full Load + CDC | Full Load 100%, Validation Pending/Failed 0건, 주요 테이블 행 수 PASS |
| PostgreSQL | Dump/Restore + Catalog 적재 | Catalog 행 수, `vector(1024)` 타입, HNSW Index PASS |

MySQL 22개 테이블과 주요 도메인 데이터의 행 수를 확인했고, PostgreSQL은 전체 28,259개 행과 벡터 타입, 검색 인덱스를 확인했습니다. 단순한 총 행 수뿐 아니라 V2 애플리케이션이 의존하는 데이터 구조까지 검증 항목에 포함했습니다.

## 실패를 전제로 한 복구 절차

자동 Cutover는 성공 경로만 빨라져서는 안 됩니다. 6차 Workflow에는 Gate 해제 전에 작업이 실패하거나 취소될 경우 다음 순서로 복구하도록 구성했습니다.

1. ALB Listener Rule을 V1으로 복원한다.
2. V1 Healthy Target이 최소 1개인지 확인한다.
3. Write Gate를 해제한다.
4. V2 전환 과정에서 바꾼 사용자 상태를 복원한다.

최종 실행에서는 Cutover가 성공해 복구 단계가 실행되지 않았습니다. 그러나 실패 시 사람이 상황을 다시 해석하고 명령을 조합하지 않아도 된다는 점이 Production 전환을 결정하는 중요한 조건이었습니다.

## 6차례의 개선 결과

| 회차 | 환경 | 전환 방식 | 실행 방식 | 쓰기 제어 | 기록된 쓰기 제한 시간 |
| --- | --- | --- | --- | --- | ---: |
| 1차 | Staging | DNS | 수동 | Nginx Freeze | 46분 35초 이상 |
| 2차 | Staging | ALB | 수동 | ALB Gate | 630초 |
| 3차 | Staging | ALB | 수동 | ALB Gate | 327~349초 |
| 4차 | Staging | ALB | 자동 | ALB Gate | 59초 |
| 5차 | Production | ALB | 자동 | ALB Gate | 129초 |
| 6차 | Production | ALB | 자동 | ALB Gate | Workflow 93초 / AWS Rule 최대 103초 |

2차의 630초에서 6차 Workflow 기준 93초까지 537초, 약 85.2%를 줄였습니다. 첫 리허설의 46분 이상과 비교하면 차이는 더 큽니다.

| 영역 | 초기 방식 | 최종 방식 |
| --- | --- | --- |
| 트래픽 전환 | Route53 DNS 변경 | ALB Listener Rule Weight 변경 |
| 실행 | 수동 명령 | GitHub Actions Workflow |
| 사전 검증 | 수동 | Preflight 20/20 자동 검증 |
| 쓰기 제어 | Nginx Write Freeze | ALB Write Gate |
| Target 검증 | 수동 확인 | Workflow 자동 검증 |
| 데이터 검증 | 개별 확인 | DMS·MySQL·PostgreSQL 통합 검증 |
| 복구 | 수동 | V1 복원과 Gate 해제 자동화 |
| 관측 | 운영 로그 중심 | CloudWatch·CloudTrail·Grafana 교차 검증 |

## 여섯 번의 실행에서 배운 점

### Cutover 전에 결정되는 전환 시간

쓰기 제한 시간을 가장 크게 줄인 변화는 더 빠른 명령이 아니었습니다. PostgreSQL 적재, ECS 기동, Target Health 확인, Smoke Test처럼 미리 할 수 있는 작업을 Gate 밖으로 옮긴 것이었습니다. Cutover 안에는 데이터의 최종 기준점을 만드는 데 꼭 필요한 작업만 남겨야 합니다.

### 속도보다 중요한 자동화의 재현성

수동 절차는 같은 문서를 따라도 실행 시간과 판단이 달라집니다. 자동화한 Workflow는 단계의 순서, 성공 조건, 실패 지점과 복구 경로를 실행 기록으로 남겼습니다. 덕분에 각 회차의 차이를 비교하고 다음 병목을 찾을 수 있었습니다.

### 성공 로그만으로 증명할 수 없는 전환 연속성

Workflow의 `success`는 AWS API 호출이 성공했다는 뜻입니다. 실제 요청이 계속 처리됐는지는 ALB RequestCount와 RequestCountPerTarget으로, 처리 용량은 Target Health와 Running Task로, 오류는 5xx와 연결 지표로 따로 확인해야 합니다.

이번 결과도 “완전한 무중단”이라고 단정하기보다 **1분 단위 AWS 관측 지표에서 읽기 요청의 중단이 관측되지 않았다**고 표현하는 것이 정확합니다. 쓰기와 인증 요청은 데이터 정합성을 위해 최대 103초 동안 의도적으로 제한했습니다.

### 결과와 함께 남겨야 하는 측정 기준

같은 Gate도 Workflow가 확인한 시간은 93초, AWS Rule 수명은 최대 103초였습니다. 시작과 종료를 어디에서 측정했는지 적지 않으면 서로 다른 숫자가 모순처럼 보입니다. 운영 결과에는 수치뿐 아니라 측정 위치와 기준을 함께 남겨야 합니다.

## 마치며

NeedU의 V1 → V2 마이그레이션은 DNS를 직접 바꾸던 수동 전환에서 시작해 ALB 기반 자동 Cutover까지 발전했습니다. 최종 Production 실행에서는 Preflight 20개가 모두 통과했고, V1에서 V2로 요청 처리 대상이 이동하는 동안 1분 단위 요청 공백과 Target 오류는 관측되지 않았습니다. DMS Validation과 MySQL·PostgreSQL 검증도 모두 통과했습니다.

물론 46분이 넘던 쓰기 제한을 103초까지 줄인 결과도 의미가 큽니다. 하지만 이번 과정을 통해 얻은 가장 큰 성과는 따로 있다고 생각합니다. 성공 조건을 지표로 정의하고, 전환 전에 할 일을 분리하고, 실행과 복구를 자동화하고, 실제 사용자 요청의 흐름으로 결과를 검증하는 방법을 갖추게 된 것입니다.

아직 개선할 점도 남아 있습니다. 앞으로는 전환 직후의 응답시간 안정화 구간을 더 세밀하게 관측하고, 쓰기 제한 중 사용자 경험과 재시도 정책도 함께 다듬을 계획입니다.

### 참고 자료

- [Google SRE: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Google SRE: Availability Table](https://sre.google/sre-book/availability-table/)
- [AWS Prescriptive Guidance: Cutover](https://docs.aws.amazon.com/prescriptive-guidance/latest/replatform-mainframe-apps-shared-db2/cutover.html)
- [AWS Prescriptive Guidance: Transactional Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [Amazon SQS: At-least-once Delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)
- [ProxySQL: Read/Write Split](https://proxysql.com/documentation/proxysql-read-write-split-howto)
