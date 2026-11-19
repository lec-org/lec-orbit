# 多阶段轻量构建：单二进制静态编译，最终镜像 < 25MB，校园机快速构建
ARG GO_IMAGE=golang:1.24-alpine
ARG ALPINE_IMAGE=alpine:3.21

FROM ${GO_IMAGE} AS builder
WORKDIR /src
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go test ./... && go build -trimpath -ldflags="-s -w" -o /out/orbit-server ./cmd/orbit-server

FROM ${ALPINE_IMAGE} AS runtime
ARG APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${APK_MIRROR%/}#g" /etc/apk/repositories \
    && apk add --no-cache ca-certificates tzdata \
    && addgroup -S orbit && adduser -S -G orbit orbit

WORKDIR /app
COPY --from=builder /out/orbit-server /app/orbit-server
USER orbit
EXPOSE 8080
ENTRYPOINT ["/app/orbit-server"]
