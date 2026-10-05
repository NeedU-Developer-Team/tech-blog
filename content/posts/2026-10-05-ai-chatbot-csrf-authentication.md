---
title: “나쁜 말 안 했는데 왜 차단돼요?” AI 챗봇을 멈춘 범인 찾기 과정
description: AI 챗봇과 대화하던 사용자가 갑자기 “접근 권한이 없습니다.”를 보고 차단당했다고 오해한 문제. 용의자를 하나씩 지워 가며 쿠키 기반 JWT 인증과 Spring Security CSRF 설정에 숨어 있던 세 가지 원인을 찾아낸 과정을 공유합니다.
date: 2026-10-05
author: 노주연
category: Backend
tags: [Spring Security, CSRF, JWT]
featured: false
---

NeedU의 AI 챗봇은 사용자와 대화하며 취향을 알아 가는 서비스입니다. 그런데 한 사용자가 AI와 한참 대화를 이어 가다가, 메시지를 보낸 순간 이런 문구를 받았습니다.

> “접근 권한이 없습니다.”

그리고 저희에게 이렇게 물었습니다.

> “나쁜 말 안 썼는데 왜 차단당한 거예요?”

![디스코드 팀 대화방 중](/images/2026-10-05-ai-chatbot-csrf-authentication/discord-message.png "디스코드 팀 대화방 중")

사용자 입장에서는 충분히 그렇게 느낄 만했습니다. 아무 문제 없이 대화하던 AI가 갑자기 "권한이 없다"고 말하면, 내가 뭔가 잘못 입력해서 제재를 받았다고 생각하게 됩니다. 메시지를 다시 보내도 같은 문구만 반복됐으니 더 그랬을 겁니다.

하지만 NeedU에는 대화 내용을 보고 사용자를 차단하는 기능이 없습니다. 사용자는 아무 잘못도 하지 않았는데, 서버가 "당신은 권한이 없다"고 말하고 있었던 것입니다.

이 글은 이 한 줄짜리 문의에서 출발해 범인을 찾아간 과정입니다. 결론부터 말하면 범인은 욕설 필터도, 계정 차단도 아닌 **Spring Security의 CSRF 설정**이었고, 그 뒤에는 서로 얽힌 세 가지 원인이 숨어 있었습니다.

## 정말 차단당한 걸까? 용의자 지우기

먼저 서버가 사용자에게 403을 내려보낼 수 있는 경우를 모두 꺼내 놓고 하나씩 지워 나갔습니다. 다행히 단서가 하나 있었습니다. NeedU는 403의 원인마다 **서로 다른 문구**를 내려주고 있었습니다.

| 용의자 | 실제로 그랬다면 보였을 응답 | 판정 |
|---|---|---|
| 운영 정책상 계정 차단 | 403 “이용이 제한된 계정입니다.” | 문구가 다름 |
| 다른 사람의 대화방 접근 | 403 “해당 AI 대화에 접근할 수 없습니다.” | 문구가 다름 |
| AI 서버가 대화를 거절 | 5xx “일시적으로 서비스를 이용할 수 없습니다.” | 상태 코드부터 다름 |
| 대화 내용 필터링 | BE에 해당 기능 없음 | 해당 없음 |

사용자가 본 **“접근 권한이 없습니다.”** 는 어떤 비즈니스 로직에서도 쓰지 않는 공통 문구였습니다. 코드를 따라가 보니 이 문구는 단 한 곳, Spring Security의 `AccessDeniedHandler`에서만 내려가고 있었습니다.

즉 요청은 컨트롤러에 닿기도 전에 **보안 필터에서 거절**되고 있었습니다. 로그인한 사용자가 보낸 POST 요청을 보안 필터가 403으로 막는 대표적인 경우는 CSRF 검증 실패입니다. 용의자가 좁혀졌습니다.

문제는 증거였습니다. 보안 필터에서 거절된 요청은 `GlobalExceptionHandler`를 거치지 않기 때문에 **서버 로그에 아무것도 남아 있지 않았습니다**. 로그 대신 재현으로 조건을 찾아야 했습니다.

## 문제는 15분 뒤에 나타났다

재현해 보니 일정한 조건이 있었습니다.

- 로그인 직후에는 메시지를 정상적으로 보낼 수 있었습니다.
- 대화창을 약 15분 이상 열어 둔 뒤 메시지를 보내면 403이 발생했습니다.
- 이후 메시지를 다시 보내도 같은 403이 반복됐습니다.
- 페이지를 새로고침하면 다시 정상적으로 사용할 수 있었습니다.

사용자가 "한참 대화하다가" 차단당했다고 느낀 이유가 여기 있었습니다. 15분은 액세스 토큰의 유효 시간과 같았습니다.

그렇다면 이상한 점이 하나 생깁니다. 액세스 토큰이 만료되면 401이 발생하고, FE가 리프레시 토큰으로 액세스 토큰을 재발급하는 흐름이 이미 있었습니다. 사용자는 아무것도 모른 채 대화를 이어 갈 수 있어야 했습니다.

하지만 실제 응답은 401이 아니라 403이었습니다. **CSRF 검사가 인증 검사보다 먼저 요청을 막으면서 토큰 재발급 흐름까지 도달하지 못한 것**입니다. 그런데 로그인 직후에는 멀쩡하던 CSRF 검사가 왜 15분 뒤에만 실패할까요? 이 질문을 따라가려면 인증 구조부터 봐야 했습니다.

## 인증 요청에는 세 가지 값이 필요하다

문제를 이해하려면 서비스에서 사용하던 인증 구조를 먼저 살펴봐야 합니다.

| 요소 | 역할 | 전달 방식 |
|---|---|---|
| 액세스 토큰 | 로그인한 사용자인지 확인 | HttpOnly 쿠키 |
| 리프레시 토큰 | 만료된 액세스 토큰 재발급 | HttpOnly 쿠키 |
| CSRF 토큰 | 다른 사이트가 사용자를 대신해 보낸 요청인지 확인 | 쿠키의 원본과 요청 헤더의 사본 비교 |

수정 전 보안 설정은 다음과 같았습니다. 핵심만 남기고 간략하게 줄였습니다.

```java
CookieCsrfTokenRepository csrfTokens = new CookieCsrfTokenRepository();
csrfTokens.setCookieName(cookieSecure ? "__Host-NEEDU_CSRF" : "NEEDU_CSRF");
csrfTokens.setCookieCustomizer(cookie -> cookie
        .httpOnly(true)
        .secure(cookieSecure)
        .sameSite("Lax")
        .path("/"));

// Authorization 헤더 대신 쿠키에서 JWT를 꺼낸다
BearerTokenResolver cookieTokenResolver = request -> {
    if (isAuthPath(request)) { // /auth/csrf, /auth/refresh, /auth/logout, 카카오 로그인
        return null;
    }
    Cookie cookie = WebUtils.getCookie(request, AuthCookieNames.ACCESS_TOKEN);
    return cookie == null ? null : cookie.getValue();
};

return http
        .sessionManagement(session -> session
                .sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .oauth2ResourceServer(oauth2 -> oauth2
                .bearerTokenResolver(cookieTokenResolver)
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter())))
        .csrf(csrf -> csrf.csrfTokenRepository(csrfTokens))
        .build();
```

서버는 커스텀 `BearerTokenResolver`로 `Authorization` 헤더가 아닌 **쿠키에서 JWT를 꺼냈습니다**. 세션은 만들지 않는 `STATELESS` 방식이었습니다. 인증 경로에서는 액세스 토큰을 읽지 않도록 해서, 만료된 액세스 토큰 쿠키가 남아 있어도 `/auth/refresh`나 `/auth/csrf`가 401로 막히지 않게 했습니다.

CSRF 토큰의 원본도 쿠키에 저장했지만, 보안을 위해 HttpOnly로 설정했기 때문에 FE가 쿠키를 직접 읽을 수는 없었습니다. 대신 FE는 `GET /api/v1/auth/csrf` 응답 본문에서 토큰을 받아 상태 변경 요청의 `X-XSRF-TOKEN` 헤더에 담았습니다.

정상적인 만료 흐름은 다음과 같아야 했습니다.

```text
메시지 전송
  → CSRF 검증 통과
  → 액세스 토큰 만료 확인
  → 401 응답
  → FE가 액세스 토큰 재발급
  → 기존 메시지 전송 재시도
```

그러나 실제 환경에서는 서로 연결된 세 가지 문제가 이 흐름을 막고 있었습니다.

## 원인 1. 인증된 요청마다 CSRF 쿠키가 삭제됐다

서비스는 `SessionCreationPolicy.STATELESS`를 사용하므로 서버 세션에 `SecurityContext`를 저장하지 않습니다. 이 상태에서 JWT로 인증된 요청이 들어오면 `SessionManagementFilter`는 매번 새로운 인증이 발생한 것처럼 판단했습니다.

새로운 인증으로 판단되면 기본 `CsrfAuthenticationStrategy`가 실행됩니다. 이 전략은 로그인 직후 CSRF 토큰을 교체하기 위해 기존 토큰을 삭제합니다. `CookieCsrfTokenRepository`는 토큰 삭제를 "빈 값에 수명이 0인 쿠키"로 표현하기 때문에, 인증된 요청의 응답마다 다음과 같은 헤더가 붙었습니다.

```http
HTTP/1.1 200
Set-Cookie: __Host-NEEDU_CSRF=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax
```

결과적으로 사용자가 로그인한 뒤 API를 호출할 때마다 브라우저는 CSRF 쿠키를 지우고 있었습니다.

> 로그인할 때 한 번 실행되어야 할 CSRF 토큰 교체가 모든 인증 요청에서 반복되고 있었습니다.

## 원인 2. 액세스 토큰이 있으면 CSRF 검사를 건너뛰었다

Spring Security의 OAuth2 Resource Server는 베어러 토큰이 있는 요청을 기본적으로 CSRF 검사 대상에서 제외합니다. `oauth2ResourceServer()`를 설정하면 내부에서 CSRF 설정에 "베어러 토큰이 있는 요청은 무시한다"는 조건을 추가합니다.

일반적인 Resource Server는 클라이언트가 `Authorization` 헤더에 토큰을 직접 넣어 보냅니다. 브라우저가 이 헤더를 자동으로 첨부하지 않기 때문에 CSRF 공격 위험이 낮다는 전제입니다.

하지만 NeedU는 베어러 토큰을 **브라우저가 자동으로 전송하는 쿠키**에 저장하고 있었습니다. Spring Security는 커스텀 Resolver가 쿠키에서 꺼낸 값도 베어러 토큰으로 인식해 CSRF 검사를 생략했습니다.

이 동작은 두 가지 문제를 만들었습니다.

- 쿠키 기반 인증인데도 로그인 사용자의 상태 변경 요청에 CSRF 보호가 적용되지 않았습니다.
- CSRF 쿠키가 이미 삭제됐지만, 액세스 토큰이 살아 있는 동안에는 검사를 건너뛰어 문제가 드러나지 않았습니다.

## 원인 3. 모든 403 응답이 똑같았다

CSRF 토큰 누락이나 불일치로 발생한 403과 일반적인 권한 부족 403이 모두 같은 핸들러, 같은 응답을 사용했습니다.

```java
@Override
public void handle(HttpServletRequest request, HttpServletResponse response,
                   AccessDeniedException accessDeniedException) throws IOException {
    errorResponseWriter.write(response, CommonErrorCode.COMMON_FORBIDDEN);
}
```

```json
{
  "message": "접근 권한이 없습니다.",
  "data": null
}
```

이 응답은 세 곳에서 문제를 만들었습니다.

- **사용자**: "보안 토큰을 다시 받으면 되는" 일시적인 상황인데도 "권한이 없다"는 문구를 보고 차단당했다고 오해했습니다.
- **FE**: 이 응답만으로는 CSRF 토큰을 다시 받으면 해결되는 문제인지, 실제로 권한이 없는 요청인지 구분할 수 없었습니다.
- **BE**: CSRF 거부는 컨트롤러보다 앞선 보안 필터에서 발생해 `GlobalExceptionHandler` 로그에도 남지 않았습니다. 앞에서 증거 없이 재현부터 해야 했던 이유입니다.

## 세 문제가 만나는 순간

각 문제는 따로 보면 즉시 장애를 만들지 않았습니다. 세 문제가 액세스 토큰 만료 시점에 만나면서 비로소 사용자에게 드러났습니다.

```text
1. 로그인 후 CSRF 토큰 발급
2. 인증된 API 요청
   → 액세스 토큰이 있어 CSRF 검사 생략
   → 동시에 CSRF 쿠키 삭제
3. 15분 뒤 액세스 토큰 만료
   → 브라우저가 만료된 액세스 토큰 쿠키를 보내지 않음
4. 메시지 전송
   → 베어러 토큰이 없으므로 CSRF 검사 실행
   → 앞에서 CSRF 쿠키가 삭제됐으므로 403
5. FE는 401에서만 토큰을 재발급
   → 재발급이 실행되지 않고 403 반복
```

문제를 더 알아보기 어려웠던 이유도 여기에 있습니다. **로그인이 유효한 15분 동안은 CSRF 쿠키를 계속 지우면서도 정작 CSRF 검사는 하지 않았습니다.** 액세스 토큰이 만료된 순간에야 숨겨져 있던 문제가 나타났습니다.

## 수정은 순서가 중요했다

가장 직접적인 해결책은 원인 2를 고쳐 모든 상태 변경 요청에 CSRF 검사를 다시 적용하는 것이었습니다. 하지만 이것부터 적용하면, 이미 CSRF 쿠키가 지워진 로그인 사용자의 요청이 전부 403으로 막힙니다.

그래서 먼저 FE가 CSRF 실패를 알아보고 복구할 수 있게 만들고, 쿠키가 지워지는 문제를 고친 뒤에 CSRF 검사를 정상화했습니다.

### 1. CSRF 실패를 별도 응답으로 분리했다

먼저 CSRF 실패용 에러 코드와 응답 데이터를 추가했습니다.

```java
public enum CommonErrorCode implements ErrorCode {
    // ...
    COMMON_FORBIDDEN(HttpStatus.FORBIDDEN, "접근 권한이 없습니다."),
    COMMON_CSRF_TOKEN_INVALID(HttpStatus.FORBIDDEN, "보안 토큰이 만료되었습니다. 다시 시도해 주세요."),
    // ...
}
```

```java
public record CsrfRefreshResponse(boolean csrfTokenRefreshRequired) {
}
```

CSRF 실패는 특정 API가 아니라 모든 상태 변경 요청에서 같은 문구로 발생합니다. 그래서 도메인별 에러 코드가 아닌 공통 에러 코드에 두었습니다. 팀 컨벤션상 에러 코드 문자열은 응답 본문에 내려주지 않기 때문에, FE가 판별할 수 있는 신호는 `data`의 플래그로 전달했습니다.

그리고 `AccessDeniedHandler`에서 예외 타입으로 CSRF 실패를 구분했습니다. `MissingCsrfTokenException`과 `InvalidCsrfTokenException`은 모두 `CsrfException`의 하위 타입입니다.

```java
@Slf4j
@Component
@RequiredArgsConstructor
public class RestAccessDeniedHandler implements AccessDeniedHandler {

    private final ErrorResponseWriter errorResponseWriter;

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response,
                       AccessDeniedException accessDeniedException) throws IOException {
        // FE가 토큰 재발급으로 복구할 수 있도록 일반 403과 구분
        if (accessDeniedException instanceof CsrfException) {
            log.info("CSRF token rejected. type={}, method={}, path={}",
                    accessDeniedException.getClass().getSimpleName(),
                    request.getMethod(), request.getRequestURI());
            errorResponseWriter.write(response, CommonErrorCode.COMMON_CSRF_TOKEN_INVALID,
                    new CsrfRefreshResponse(true));
            return;
        }
        errorResponseWriter.write(response, CommonErrorCode.COMMON_FORBIDDEN);
    }
}
```

이제 CSRF 실패는 다음 응답으로 내려갑니다.

```json
{
  "message": "보안 토큰이 만료되었습니다. 다시 시도해 주세요.",
  "data": {
    "csrfTokenRefreshRequired": true
  }
}
```

로그에는 예외 종류, HTTP 메서드, 요청 경로만 기록했습니다. 인증 정보인 토큰 값은 남기지 않았습니다. 예외 종류가 남기 때문에 토큰이 아예 없었는지(`MissingCsrfTokenException`), 값이 달랐는지(`InvalidCsrfTokenException`)도 로그만으로 구분할 수 있습니다.

FE는 `data.csrfTokenRefreshRequired`가 `true`인 403만 골라 복구하고, 일반 권한 없음 응답은 기존대로 처리할 수 있습니다.

문구도 바꿨습니다. "접근 권한이 없습니다."는 사용자를 문제의 원인처럼 들리게 했습니다. 새 문구 "보안 토큰이 만료되었습니다. 다시 시도해 주세요."는 사용자가 잘못한 게 아니라는 점과 다시 시도하면 된다는 점을 함께 알려 줍니다. 그리고 FE가 이 응답을 받아 자동으로 복구하기 때문에, 대부분의 사용자는 이 문구를 볼 일조차 없습니다.

### 2. 요청마다 CSRF 쿠키가 삭제되지 않게 했다

다음으로 CSRF 설정의 세션 인증 전략을 `NullAuthenticatedSessionStrategy`로 교체했습니다.

```java
.csrf(csrf -> csrf
        .csrfTokenRepository(csrfTokens)
        // STATELESS에서 인증된 요청마다 새 로그인으로 판단돼
        // 기본 전략이 CSRF 쿠키를 매번 삭제하므로 끈다.
        .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy()))
```

`NullAuthenticatedSessionStrategy`는 인증이 일어나도 아무 일도 하지 않는 전략입니다. 서버 세션이 없는 구조라 세션 고정 공격 방어 같은 세션 관련 처리는 원래 필요하지 않았습니다. 이제 로그인 이후 발급된 CSRF 쿠키는 일반 API 응답에서 삭제되지 않습니다.

### 3. FE에 CSRF 복구 흐름을 추가했다

FE의 `apiFetch`에는 상태 변경 요청이 CSRF 전용 403을 받았을 때 다음 순서로 처리하는 로직이 필요했습니다.

```text
CSRF 403
  → getCsrfToken(true)로 CSRF 토큰 강제 재발급
  → 실패했던 요청을 1회 재시도
  → 재시도 결과가 401이면 액세스 토큰 재발급
  → 새로운 인증 정보로 다시 요청
```

이때 중요한 점은 재시도할 때 `createRequestInit`을 다시 호출하는 것입니다. 기존 요청 설정을 그대로 재사용하면 새로 발급한 CSRF 토큰이 아니라 이전 헤더가 다시 전송됩니다.

기존의 `401 → refresh → 재시도` 흐름에도 같은 문제가 있을 수 있어, 액세스 토큰을 재발급한 뒤에도 요청 설정을 새로 만들도록 함께 정리했습니다.

CSRF 재시도는 반드시 **한 번으로 제한**했습니다. 모든 403에서 `/auth/csrf`를 반복 호출하면 일반 권한 오류에서도 무한 재시도가 발생할 수 있습니다. 실제 장애 분석에서도 한 IP가 CSRF API를 짧은 시간에 반복 호출해 nginx 연결 수를 소진했을 가능성이 원인 후보로 확인됐습니다.

### 4. 액세스 토큰과 관계없이 CSRF를 검사했다

복구 흐름을 준비한 뒤 CSRF 보호를 정상화했습니다.

`CsrfFilter`가 Spring의 기본 검사 조건(`DEFAULT_CSRF_MATCHER`)을 사용하도록 되돌려 GET, HEAD, TRACE, OPTIONS를 제외한 모든 요청을 검사했습니다.

`oauth2ResourceServer()`가 추가하는 "베어러 토큰 요청은 무시" 조건은 `csrf()` 설정 메서드로 지울 수 없었습니다. 그래서 `CsrfFilter` 객체가 만들어진 뒤에 개입할 수 있는 `ObjectPostProcessor`로 검사 조건을 통째로 교체했습니다. 최종 CSRF 설정은 다음과 같습니다.

```java
.csrf(csrf -> csrf
        .csrfTokenRepository(csrfTokens)
        // STATELESS에서 인증된 요청마다 새 로그인으로 판단돼
        // 기본 전략이 CSRF 쿠키를 매번 삭제하므로 끈다.
        .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy())
        // 리소스 서버는 베어러 토큰이 포함된 요청을 CSRF 검사에서 제외하므로
        // 액세스 토큰 유무와 관계없이 모든 상태 변경 요청을 검사하도록 되돌린다.
        .withObjectPostProcessor(new ObjectPostProcessor<CsrfFilter>() {
            @Override
            public <O extends CsrfFilter> O postProcess(O filter) {
                filter.setRequireCsrfProtectionMatcher(CsrfFilter.DEFAULT_CSRF_MATCHER);
                return filter;
            }
        }))
```

이제 액세스 토큰이 유효하더라도 CSRF 쿠키와 헤더가 없거나 서로 다르면 요청이 거절됩니다.

### 5. 운영 쿠키 보안 설정을 강화했다

운영 환경에는 `AUTH_COOKIE_SECURE=true`를 적용했습니다. 인증과 CSRF 쿠키에 `Secure` 속성과 `__Host-` 접두사를 사용해 HTTPS 연결에서만 쿠키가 전송되도록 했습니다.

`__Host-` 접두사가 붙은 쿠키는 브라우저가 `Secure`, `Path=/`, `Domain` 속성 없음을 강제합니다. 하위 도메인이나 HTTP 연결에서 같은 이름의 쿠키를 덮어쓰는 공격을 막을 수 있습니다.

## 수정 전후의 요청 흐름

상태를 변경하는 POST, PUT, PATCH, DELETE 요청은 다음과 같이 달라졌습니다.

| 액세스 토큰 | CSRF 쿠키와 헤더 | 수정 전 | 수정 후 |
|---|---|---|---|
| 유효 | 없음 또는 불일치 | CSRF 검사 없이 통과 | 전용 403 반환 후 FE가 1회 복구 시도 |
| 유효 | 유효 | 통과하지만 CSRF 쿠키 삭제 | 정상 통과하고 CSRF 쿠키 유지 |
| 없음 또는 만료 | 유효 | 401 반환 | 401 반환 후 FE가 액세스 토큰 재발급 |
| 없음 또는 만료 | 없음 | 일반 403 이후 복구 불가 | 전용 403 반환 후 CSRF 재발급 가능 |

핵심은 401과 403의 역할을 다시 분리한 것입니다.

- **401**은 인증이 필요하거나 액세스 토큰을 재발급해야 하는 상태입니다.
- **CSRF 403**은 CSRF 토큰을 새로 받은 뒤 한 번 재시도할 수 있는 상태입니다.
- **일반 403**은 인증은 됐지만 해당 작업을 수행할 권한이 없는 상태입니다.

## 필터 체인 전체를 테스트했다

이번 문제는 하나의 클래스가 아니라 세션 관리, Resource Server, CSRF 필터의 조합에서 발생했습니다. 따라서 개별 핸들러 단위 테스트만으로는 실제 동작을 보장하기 어려웠습니다.

`@SpringBootTest`와 MockMvc를 사용해 실제 보안 필터 체인을 통과시키며 검증했습니다. 먼저 인증된 요청 뒤에 CSRF 쿠키 삭제 응답이 없는지 확인했습니다.

```java
@Test
void authenticatedRequest_withCsrfCookie_keepsCsrfCookie() throws Exception {
    Cookie csrfCookie = mockMvc.perform(get("/api/v1/auth/csrf"))
            .andReturn().getResponse().getCookie(CSRF_COOKIE);

    MvcResult result = mockMvc.perform(get("/api/v1/guidance").cookie(accessCookie(), csrfCookie))
            .andReturn();

    // 응답에 CSRF 쿠키 삭제(Max-Age=0)가 실려 있지 않아야 한다
    assertThat(result.getResponse().getCookie(CSRF_COOKIE)).isNull();
}
```

액세스 토큰이 있어도 CSRF가 없으면 전용 403이 나오는지 확인했습니다.

```java
@Test
void accessTokenWithoutCsrf_postRequest_returnsCsrfRefreshRequired() throws Exception {
    mockMvc.perform(post("/api/v1/ai/conversations/1/messages").cookie(accessCookie()))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.data.csrfTokenRefreshRequired").value(true));
}
```

그리고 가장 중요한 테스트로, 액세스 토큰은 없지만 CSRF가 유효하면 403이 아닌 401이 나오는지 확인했습니다.

```java
@Test
void validCsrfWithoutAccessToken_postRequest_returnsUnauthorized() throws Exception {
    MvcResult csrf = mockMvc.perform(get("/api/v1/auth/csrf")).andReturn();
    Cookie csrfCookie = csrf.getResponse().getCookie(CSRF_COOKIE);
    String csrfToken = JsonPath.read(csrf.getResponse().getContentAsString(), "$.data.token");

    mockMvc.perform(post("/api/v1/ai/conversations/1/messages")
                    .cookie(csrfCookie)
                    .header(CSRF_HEADER, csrfToken))
            .andExpect(status().isUnauthorized());
}
```

CSRF가 유효한 요청은 인증 검사까지 도달해 401을 받아야 FE의 액세스 토큰 재발급 흐름이 작동합니다. 이 테스트가 이번 장애의 핵심인 "401보다 403이 먼저 나가는" 상황을 다시 막아 줍니다.

이 밖에도 다음 경우를 함께 검증했습니다.

- 인증된 POST 이후에도 CSRF 쿠키가 유지되는지 확인했습니다.
- 액세스 토큰과 잘못된 CSRF 값이 있으면 전용 403이 반환되는지 확인했습니다.
- 액세스 토큰과 CSRF 값이 모두 유효하면 컨트롤러까지 도달하는지 확인했습니다.

## 배포 순서도 인증 흐름의 일부였다

코드가 모두 준비됐더라도 배포 순서를 바꾸면 기존 로그인 사용자의 요청이 대량으로 실패할 수 있었습니다.

```text
1. CSRF 전용 응답 적용
2. CSRF 쿠키 삭제 문제 수정
3. FE의 CSRF 재발급과 1회 재시도 적용
4. 모든 상태 변경 요청에 CSRF 검사 적용
5. 운영 환경의 Secure 쿠키 설정 확인
```

특히 4번을 먼저 배포하면 이미 CSRF 쿠키가 삭제된 사용자의 요청이 즉시 403으로 차단됩니다. 보안 기능을 강화하는 변경일수록 서버 코드뿐 아니라 클라이언트의 복구 가능 여부와 배포 순서까지 함께 설계해야 했습니다.

## 이번 문제에서 배운 점

### 사용자는 에러 문구로 시스템을 해석한다

개발자에게 403은 "Spring Security가 요청을 거절했다"는 뜻이지만, 사용자에게 “접근 권한이 없습니다.”는 "당신이 뭔가 잘못했다"로 읽힙니다. 특히 AI와 대화하는 화면에서는 그 해석이 "내가 한 말 때문에 차단당했다"로 이어졌습니다. 에러 문구는 로그가 아니라 **사용자에게 보내는 메시지**라는 점을 이번에 확실히 배웠습니다.

### 프레임워크의 기본값에는 전제가 있다

베어러 토큰 요청을 CSRF 검사에서 제외하는 기본 동작은 `Authorization` 헤더를 사용하는 환경에서는 합리적입니다. 하지만 토큰을 쿠키에서 읽는 순간 그 전제는 달라집니다. 기본 설정을 사용하는 것보다 **우리 서비스의 인증 정보가 실제로 어떻게 전달되는지** 확인하는 일이 먼저였습니다.

### 에러 응답은 복구 흐름을 결정하는 계약이다

401과 403을 단순한 상태 코드로만 보면 비슷해 보일 수 있습니다. 하지만 FE에서는 어떤 토큰을 다시 받아야 하는지, 재시도해도 되는지 결정하는 제어 신호입니다. 복구 가능한 CSRF 403과 일반 권한 없음 403을 구분한 이유입니다.

### 재시도에는 종료 조건이 필요하다

자동 복구는 사용자 경험을 좋아지게 하지만, 제한 없는 재시도는 더 큰 장애로 이어질 수 있습니다. 이번에는 응답의 명시적인 플래그를 확인하고 CSRF 재시도를 한 번으로 제한했습니다.

### 보안 필터 문제는 실제 체인으로 검증해야 한다

각 필터가 개별적으로 올바르게 동작해도 순서와 조합에 따라 결과가 달라질 수 있습니다. 이번 문제처럼 401보다 CSRF 403이 먼저 발생하는 상황은 실제 필터 체인을 통과시키는 테스트가 있어야 재발을 막을 수 있습니다.

## 당신은 차단당하지 않았습니다

이번 수정으로 AI 챗봇 대화가 멈추는 직접적인 원인과 로그인 사용자의 CSRF 보호 누락을 해결할 수 있었습니다.

“나쁜 말 안 했는데 왜 차단돼요?”라는 질문의 답은 결국 "당신은 차단당하지 않았습니다"였습니다. 사용자를 막은 건 욕설 필터가 아니라, 각각 합리적으로 보이던 Spring Security의 기본 동작들이 우리 서비스의 인증 방식과 어긋나면서 생긴 틈이었습니다.

눈앞의 403만 처리하는 대신 쿠키가 발급되고 삭제되는 시점, 필터가 실행되는 순서, FE와 사용자가 응답을 해석하는 방식까지 한 흐름으로 살펴본 덕분에 보안과 사용자 경험을 함께 바로잡을 수 있었습니다.

이제 15분이 지나도 AI 챗봇은 아무 일 없다는 듯 대화를 이어 갑니다.
