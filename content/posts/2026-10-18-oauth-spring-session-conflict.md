---
title: 카카오 로그인 창에서 그냥 돌아왔을 뿐인데, 왜 API가 500을 뱉을까?
description: 토큰을 잘 갱신했는데도 새로고침만 하면 터지던 500 에러. 범인은 JWT가 아니라 카카오 로그인 창을 닫고 돌아온 사용자의 브라우저에 남아 있던 SESSION 쿠키 한 조각이었습니다.
date: 2026-10-18
author: 정지호
category: Backend
tags: [Spring Security, Spring Session, OAuth, Redis]
featured: false
---

안녕하세요. NeedU 백엔드팀 정지호입니다.

이번 글의 범인은 쿠키 입니다. 분명 무효화 잘 했는데..

시작은 평범했습니다. 액세스 토큰이 만료됐을 때 재발급 흐름이 잘 동작하는지 확인해 보려던 참이었습니다. 메인 페이지에 액세스토큰이 만료될 때까지 기다렸다가 새로고침을 했는데 일부 api의 응답이 500으로 내려왔습니다.

```text
GET /api/v1/auth/session  500
GET /api/v1/guidance      500
```

401이었다면 고개를 끄덕였을 겁니다. 오래 자리를 비웠으니 액세스 토큰이 만료됐을 테고, FE가 리프레시 토큰으로 갱신하면 끝나는 일이니까요. 그런데 실제로는 **토큰 갱신까지 성공한 뒤에 다시 보낸 요청이 500**으로 끝나고 있었습니다.

결론부터 말하면 이 500은 JWT와 아무 상관이 없었습니다. 친구 동기화 진행 중 카카오 로그인 화면에서 **로그인을 끝내지 않고 그냥 돌아왔을 때** 남은 쿠키 하나가 전혀 관계없는 API들을 쓰러뜨리고 있었습니다.

## 첫 번째 용의자: 동시에 쏟아지는 재요청

재현 조건은 꽤 분명했습니다.

1. 메인 페이지를 연 채로 액세스 토큰이 만료될 때까지 기다린다.
2. 새로고침한다.
3. FE가 토큰을 갱신하고, 실패했던 요청을 다시 보낸다.
4. 그중 몇 개가 500으로 죽는다.

3번에서 FE는 실패했던 `/guidance`, `/summary`, `/session` 요청을 `Promise.all`로 한꺼번에 다시 보냅니다.

![토큰 갱신 후 /guidance, /summary, /auth/session을 Promise.all로 동시에 재요청하는 흐름](/assets/images/posts/oauth-spring-session-conflict/01-refresh-retry.png)

처음에 "동시에"라는 단어에 집중했습니다. 토큰을 갈아 끼우는 사이에 요청 몇 개가 꼬인 게 아닐까?

그런데 생각할수록 이상했습니다. JWT 인증은 요청마다 토큰을 독립적으로 검증합니다. 요청끼리 무언가를 공유하지 않는데 서로 꼬일 일이 없습니다. 꼬인다고 해도 401이나 403이 나와야지 500이 나올 이유가 없었습니다.

물론 FE에서 재요청을 하나씩 순서대로 보내면 증상은 사라졌을지도 모릅니다. 하지만 페이지가 API를 병렬로 부르는 건 지극히 정상적인 일입니다. 그걸 서버가 못 버틴다면 순서를 바꾸는 건 해결이 아니라 **문제를 가리는 것**이라고 생각했습니다.

병렬 요청은 공범일 수는 있어도 주범은 아니었습니다.

## Sentry가 알려 준 엉뚱한 이름, RENAME

Sentry를 열자 전혀 예상하지 못한 스택이 나왔습니다.

```text
RedisCommandExecutionException: ERR no such key
RedisTemplate.rename
RedisSessionRepository.saveChangeSessionId
```

JWT 검증도, 리프레시 토큰도 아니었습니다. **Spring Session이 Redis의 세션 키 이름을 바꾸다가** 실패하고 있었습니다.

잠깐, 우리 서비스는 JWT 기반인데 세션이 왜 나오지?

브라우저 쿠키를 열어 보고 나서야 깨달았습니다. 거기엔 이미 무효화 되었어야 할 쿠키가 하나 끼어 있었습니다.

```text
NEEDU_ACCESS_TOKEN=<JWT>
NEEDU_REFRESH_TOKEN=<TOKEN>
SESSION=<SPRING_SESSION_ID>   ← 너는 누구니?
```

질문이 완전히 바뀌었습니다.

> JWT로 인증하는 일반 API에 왜 `SESSION` 쿠키가 따라오고 있고, Spring Security는 왜 그 세션의 이름을 바꾸려 하는 걸까?

## SESSION 쿠키의 정체: 카카오 OAuth의 임시 보관함

출처는 금방 찾았습니다. 카카오 OAuth였습니다.

OAuth에서는 "로그인을 시작한 브라우저"와 "callback으로 돌아온 브라우저"가 같은지 확인하기 위해 `state`라는 값을 씁니다. NeedU는 이 `state`와 로그인 후 돌아갈 주소(`returnUrl`), 친구 동기화라면 사용자 ID까지 `HttpSession`에 넣어 두고 있었습니다.

Spring Session을 쓰고 있었으니 실제 데이터는 Redis에 저장되고, 브라우저에는 그걸 찾아갈 열쇠인 `SESSION` 쿠키가 발급됩니다.

![기존 카카오 OAuth 흐름: authorize에서 세션과 SESSION 쿠키를 만들고, callback에서 state를 검증한 뒤 session.invalidate()로 삭제](/assets/images/posts/oauth-spring-session-conflict/02-oauth-flow-before.png)

4번에서 세션을 지우고 있었으니 쿠키도 사라졌어야 합니다. 처음엔 "callback 응답에서 쿠키 삭제가 제대로 안 되나?"를 의심했는데, 코드를 보니 정상 callback에서는 문제없이 지우고 있었습니다.

그럼 이 쿠키는 대체 어디서 살아남은 걸까요?

## 범인의 탈출 경로: 카카오 로그인 창에서 그냥 돌아오기

답은 친구 동기화 화면에서 나왔습니다.

브라우저의 쿠키에 카카오 세션 관련 쿠키가 유효하면 동기화 버튼을 누르자마자 카카오가 순식간에 callback으로 돌려보내 줍니다. 하지만 카카오 로그인이 풀려 있으면 카카오 로그인 화면이 뜹니다.

여기서 사용자가 "아 귀찮다" 하고 로그인을 하지 않은 채 **주소창에 NeedU 주소를 직접 쳐서 돌아오면** 어떻게 될까요?

![카카오 로그인을 완료하면 쿠키가 삭제되지만, 주소창으로 직접 복귀하면 callback이 오지 않아 SESSION 쿠키가 남는다](/assets/images/posts/oauth-spring-session-conflict/03-oauth-abandoned.png)

서버 입장에서는 사용자가 카카오 창을 닫았는지 알 방법이 없습니다. callback이 오지 않는 한 세션을 지울 기회 자체가 없습니다.

이 지점에서 방향을 바꿨습니다. 쿠키를 "더 확실하게 지우는" 방법을 찾는 건 의미가 없었습니다. 지울 기회가 아예 오지 않을 수 있으니까요. 필요한 건 **쿠키가 남더라도 영향을 끼치지 못하는 구조**였습니다.

## 남은 쿠키가 API를 쓰러뜨리기까지

쿠키가 남아 있다는 건 알았습니다. 그런데 남은 쿠키가 왜 하필 세션 키 이름을 바꾸게 만들었을까요?

Spring Security에는 **세션 고정 공격**을 막는 기능이 있습니다. 로그인 전에 쓰던 세션 ID를 공격자가 미리 심어 두는 공격을 막기 위해, 비로그인 상태에서 로그인 상태로 바뀌는 순간 세션 ID를 새로 바꿔 버리는 기능입니다. 세션 로그인을 쓰는 서비스라면 로그인할 때 딱 한 번 일어나는 일입니다.

그런데 NeedU는 `STATELESS`한 JWT 기반 서비스입니다. 서버는 인증 상태를 기억하지 않고, 요청이 올 때마다 JWT를 검증해서 "방금 인증됨" 상태를 새로 만듭니다.

![STATELESS JWT 인증은 요청마다 인증 정보 없음에서 인증됨으로 바뀌고, SESSION 쿠키가 남아 있으면 그때마다 세션 ID 변경을 시도한다](/assets/images/posts/oauth-spring-session-conflict/04-stateless-jwt.png)

Spring Security 입장에서 보면, **모든 요청이 "비로그인에서 로그인으로 바뀐 순간"** 입니다. 평소라면 바꿀 세션이 없으니 아무 일도 없습니다. 하지만 남아 있던 `SESSION` 쿠키 덕분에 세션이 있습니다. 그러니 요청마다 성실하게 세션 ID를 바꾸려 합니다.

> 로그인할 때 한 번만 일어나야 할 세션 ID 변경이, 주인 없는 쿠키 때문에 모든 API 요청에서 일어나고 있었습니다.

요청이 하나씩 올 때는 그래도 괜찮습니다. 바꾸고, 다음 요청이 바뀐 ID로 오고, 또 바꾸면 되니까요. 문제는 요청이 **동시에** 올 때입니다. 여기서 아까 놓아줬던 공범, 병렬 재요청이 다시 등장합니다.

## 같은 열쇠로 동시에 문을 연 두 요청

토큰 갱신 직후 재요청 세 개가 같은 `SESSION=abc`를 들고 거의 동시에 도착합니다. 셋 다 Redis에서 세션 `abc`를 문제없이 읽습니다. 세션 ID 변경은 요청이 끝나고 응답을 저장할 때 일어납니다.

![요청 A와 B가 같은 세션 abc를 읽은 뒤, A가 먼저 RENAME에 성공하고 B는 ERR no such key로 500이 된다](/assets/images/posts/oauth-spring-session-conflict/05-rename-race.png)

A가 먼저 `abc`를 `xyz`로 바꿔 버리면, B가 바꾸려는 `abc`는 이미 세상에 없습니다. Redis는 `ERR no such key`를 돌려주고, 그 예외는 그대로 500이 됩니다. 일부 요청만 실패한 이유도 이걸로 설명됩니다. 먼저 도착한 요청은 성공하고, 늦은 요청만 죽습니다.

정리하면 이 500은 혼자서는 아무 문제 없던 것들이 한자리에 모여 만든 사고였습니다.

- 카카오 로그인 창에서 그냥 돌아온 사용자
- 그 때문에 남은 `SESSION` 쿠키
- 매 요청을 "방금 로그인"으로 보는 JWT 인증
- 성실하게 세션 ID를 바꾸는 세션 고정 보호
- 동시에 쏟아지는 재요청

토큰 만료나 리프레시가 원인은 아니었습니다. 같은 `SESSION` 쿠키를 든 요청이 한 번에 몰리기만 하면 언제든 일어날 수 있는 경합이었고, 토큰 만료 테스트는 그 장면을 처음 목격한 자리였을 뿐입니다.

## 스위치 하나면 끝나는데, 왜 안 껐을까

사실 가장 빠른 해결책은 한 줄이었습니다.

```java
.sessionManagement(session -> session
        .sessionCreationPolicy(SessionCreationPolicy.STATELESS)
        .sessionFixation(fixation -> fixation.none()))
```

세션 고정 보호를 끄면 세션 ID를 바꾸지 않으니 `RENAME` 경합도 사라집니다. 어차피 인증은 JWT가 하니 당장 문제 될 것도 없어 보였습니다.

그래도 망설여졌습니다. 보안 관련 기본 설정을 "지금 에러가 나니까 끈다"는 이유로 변경하는 건 어딘가 찜찜하게 느껴졌습니다. 그리고 더 큰 문제는 스위치를 꺼도 **구조는 그대로 남는다**는 점이었습니다.

OAuth에서 잠깐 쓰고 버릴 데이터가 여전히 애플리케이션 전체의 범용 세션에 들어가고, 그 쿠키는 여전히 모든 API 요청에 따라다닙니다. 오늘은 세션 고정 보호와 부딪혔지만, 다음엔 다른 무언가와 부딪힐 수 있습니다. 그리고 범용 세션의 사용 목적도 단순히 state 저장용으로는 필요성이 명확하지 않다고 생각이 들었습니다.

그래서 질문을 바꿨습니다. "세션 ID 변경을 어떻게 막을까?"가 아니라

> 애초에 OAuth 데이터가 일반 API 요청에 왜 끼어 있어야 하지?

## Redis는 그대로, 주인만 바꿨다

주의할 점은 OAuth `state`가 원래도 Redis에 있었다는 겁니다. `HttpSession`에 넣으면 Spring Session이 Redis에 대신 넣어 줬을 뿐이죠. "세션 대신 Redis를 쓰자"는 해결책이 아닙니다. 바꿔야 할 건 **그 Redis 데이터를 누가 관리하느냐**였습니다.

![기존에는 Controller가 HttpSession과 Spring Session을 거쳐 Redis에 저장했고, 변경 후에는 KakaoOAuthTransactionService가 Redis를 직접 관리한다](/assets/images/posts/oauth-spring-session-conflict/06-architecture.png)

OAuth 데이터를 전용 서비스가 직접 관리하면, 더 이상 Spring Security가 들여다보고 이름을 바꾸는 "HTTP 세션"이 아닙니다. 그냥 우리가 만든 Redis 키일 뿐입니다.

키는 로그인과 친구 동기화를 나눠서 `state`를 붙여 만들고,

```text
backend:auth:kakao-oauth-login:{state}
backend:auth:kakao-oauth-friend:{state}
```

값에는 callback 이후에 정말 필요한 것만 넣었습니다. 친구 동기화일 때만 `userId`가 들어가고, 모든 데이터는 10분이 지나면 알아서 사라집니다.

```json
{
  "returnUrl": "https://needu.example.com",
  "userId": 1
}
```

## 쿠키는 남아도 된다, 대신 갈 수 있는 곳을 줄이자

여기서 한 가지가 빠집니다. `state`를 Redis에만 두면, callback으로 들어온 `state`로 데이터를 꺼낼 수는 있지만 **그 callback이 OAuth를 시작한 바로 그 브라우저에서 왔는지**는 확인할 수 없습니다. 기존 세션 쿠키가 해 주던 일이죠.

그래서 결국 쿠키를 다시 쓰기로 했습니다. 다만 이번엔 아주 좁은 쿠키입니다.

```text
NEEDU_KAKAO_LOGIN_OAUTH    Path=/api/v1/auth/kakao/callback
NEEDU_KAKAO_FRIEND_OAUTH   Path=/api/v1/friends/kakao/callback

HttpOnly · Secure · SameSite=Lax · Max-Age=10분
```

핵심은 `Path`입니다. 브라우저는 이 쿠키를 callback 주소로 갈 때만 실어 보냅니다.

![OAuth 쿠키는 Path가 일치하는 callback API에만 전송되고 일반 API에는 전송되지 않는다](/assets/images/posts/oauth-spring-session-conflict/07-cookie-path.png)

사용자가 카카오 로그인 창에서 그냥 돌아오는 일은 앞으로도 계속 생길 겁니다. 서버는 여전히 그걸 알 수 없고, 쿠키는 여전히 남습니다. 달라진 건, 이제 **남은 쿠키가 일반 API 근처에도 못 간다**는 점입니다. 그리고 10분 뒤면 스스로 사라집니다.

## 한 번 꺼낸 state는 다시 쓸 수 없게

callback에서는 쿠키의 `state`와 callback의 `state`가 같은지 먼저 확인합니다. 둘 중 하나라도 비었거나 다르면 Redis는 건드리지도 않습니다.

```java
if (state == null || state.isBlank()
        || cookieState == null || cookieState.isBlank()
        || !state.equals(cookieState)) {
    return Optional.empty();
}
```

순서가 중요합니다. 검증 전에 Redis 데이터를 지워 버리면, 엉터리 callback 하나가 정상 사용자의 OAuth를 망가뜨릴 수 있기 때문입니다.

검증을 통과하면 Redis의 `GETDEL`로 **꺼내는 것과 지우는 것을 한 번에** 처리합니다.

```java
redisTemplate.opsForValue().getAndDelete(key);
```

조회와 삭제를 따로 하면, callback이 두 번 동시에 들어왔을 때 둘 다 지워지기 전의 값을 읽을 수 있습니다. `GETDEL`을 쓰면 먼저 온 요청만 데이터를 받고, 늦은 요청은 빈손으로 돌아갑니다. 앞에서 우리를 괴롭혔던 "동시에 같은 키를 건드리는" 문제를 이번엔 우리 편으로 만든 셈입니다.

그래서 메서드 이름도 `find`가 아니라 `consume`으로 지었습니다. 한 번 먹으면 끝이라는 뜻을 이름에 담고 싶었습니다.

이 서비스는 로그인과 친구 동기화가 함께 쓰기 때문에, 실패하면 특정 예외를 던지지 않고 `Optional.empty()`만 돌려줍니다. 그걸 받은 각 Controller가 `AUTH_KAKAO_INVALID_STATE`, `FRIEND_KAKAO_INVALID_STATE`처럼 자기 상황에 맞는 에러로 바꿉니다.

## 그리고 Spring Session을 걷어냈다

코드를 다 뒤져 보니 `HttpSession`을 쓰는 곳은 카카오 OAuth 두 군데가 전부였습니다. 전환을 마치고 나니 Spring Session이 할 일이 하나도 남지 않았고, 관련 의존성과 설정을 모두 지웠습니다.

```text
spring-boot-starter-session-data-redis
SessionConfig
server.servlet.session.*
spring.session.redis.namespace
```

그리고 처음에 끌까 고민했던 세션 고정 보호 설정은 **그대로 두었습니다**. 충돌하는 기능을 끈 게 아니라, 애초에 충돌할 대상을 그 기능 앞에서 치운 겁니다.

테스트로는 전용 OAuth 쿠키가 발급되는지, `SESSION` 쿠키가 더 이상 생기지 않는지, `state`가 Redis에서 딱 한 번만 소비되는지, 로그인과 친구 동기화의 키가 섞이지 않는지, 기존 JWT API는 그대로인지를 확인했습니다.

```text
./gradlew --no-daemon clean test   → 902개 테스트 성공
./gradlew --no-daemon build        → BUILD SUCCESSFUL
runtimeClasspath                   → spring-session-core 없음
```

## 돌아보며

이번 문제에서 가장 오래 붙잡고 있었던 착각은 두 가지였습니다.

하나는 **"토큰 만료 후에 터지니까 토큰 문제겠지"** 였습니다. 사실 이 에러는 액세스 토큰이 만료됐을 때 재발급 흐름이 잘 동작하는지 확인하다가 발견한 것이었습니다. 그러다 보니 자연스럽게 토큰부터 의심했지만, 진짜 계기는 토큰 만료도 리프레시도 아닌 **요청 여러 개가 한 번에 서버에 도착하는 것** 자체였습니다. 토큰 만료 테스트는 그 장면을 처음 마주친 자리였을 뿐입니다. 문제를 발견한 상황과 문제의 원인은 다를 수 있다는 걸 다시 배웠습니다.

다른 하나는 **"`invalidate()`가 있으니 세션은 지워지겠지"** 였습니다. 정리 코드는 그 코드가 실행될 때만 의미가 있습니다. 사용자가 외부 화면으로 나갔다가 돌아오는 흐름에서는 그 순간이 아예 오지 않을 수 있습니다. 그래서 "어떻게 지울까"보다 "안 지워졌을 때 무슨 일이 생기나"를 먼저 생각해야 했습니다.

돌이켜 보면 OAuth `state`는 처음부터 세션에 어울리는 데이터가 아니었습니다. 10분 남짓 살다가 한 번 쓰이고 사라져야 하는 일회용 데이터인데 로그인 상태를 오래 붙잡아 두는 범용 세션에 들어가면서 엉뚱한 생명주기를 얻게 되었습니다.

이번 트러블슈팅을 진행하며, 세션과 쿠키를 사용할 때는 데이터의 목적에 맞게 어디에 저장하고 어디까지 전달할지를 정하는 것이 중요하다는 점을 느꼈습니다.

