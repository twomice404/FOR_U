# Panopto 개념 정리 도우미

이 폴더는 Panopto 강의 페이지에서 대본 텍스트를 추출하고 개념 정리 노트를 만드는 크롬 확장 프로그램입니다.
OpenAI API로 정리한 뒤 Notion 페이지로 업로드할 수도 있습니다.

## 설치

1. 크롬 주소창에 `chrome://extensions` 입력
2. 오른쪽 위 `개발자 모드` 켜기
3. `압축해제된 확장 프로그램을 로드합니다` 클릭
4. 아래 폴더 선택

```text
C:\Users\leejuh\Desktop\기획조사 현장실습 이주희\작업\panopto-concept-helper
```

## OpenAI/Notion 설정

1. 크롬 확장 프로그램 목록에서 `Panopto 개념 정리 도우미`의 `세부정보`를 엽니다.
2. `확장 프로그램 옵션`을 누릅니다.
3. 아래 값을 입력하고 저장합니다.

- `OpenAI API Key`: OpenAI API 키
- `OpenAI Model`: 기본값 `gpt-5-mini`
- `Notion Internal Integration Token`: Notion 통합 토큰
- `Notion 부모 페이지 ID 또는 URL`: 정리본을 넣을 Notion 페이지 URL

Notion에서는 정리본을 넣을 페이지 오른쪽 위 메뉴에서 만든 통합을 초대해야 합니다.

## 사용

1. 이화여대 Panopto 링크를 크롬에서 열고 로그인합니다.
2. 강의 영상 페이지 오른쪽 아래의 `개념 정리` 버튼을 누릅니다.
3. `대본 추출`을 누릅니다.
4. 텍스트가 들어오면 `GPT+Notion 업로드`를 누릅니다.
5. 필요하면 `결과 복사` 또는 `Markdown 저장`을 누릅니다.

## 자동 추출이 안 될 때

Panopto 화면에서 자막/대본 메뉴를 열고 `Download transcript`로 텍스트 파일을 받은 뒤, 내용을 패널의 입력 칸에 붙여넣고 `개념 정리`를 누르면 됩니다.

## 주의

- 이 도구는 로그인된 브라우저 화면에서만 작동합니다.
- Panopto 영상에 자막/대본이 없으면 자동 추출할 텍스트도 없습니다.
- API 키는 크롬 확장 프로그램 로컬 저장소에 저장됩니다. 공용 PC에서는 사용하지 않는 편이 좋습니다.
- `개념 정리` 버튼은 API 없이 브라우저 안에서 간단히 정리하는 기능이고, `GPT+Notion 업로드`는 OpenAI/Notion API를 사용합니다.
