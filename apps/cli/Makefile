VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.version=$(VERSION) -s -w"

.PHONY: build build-all clean install

build:
	go build $(LDFLAGS) -o bin/supanow .

install:
	go build $(LDFLAGS) -o $(GOPATH)/bin/supanow .

build-all:
	GOOS=linux   GOARCH=amd64  go build $(LDFLAGS) -o dist/supanow-linux-amd64 .
	GOOS=linux   GOARCH=arm64  go build $(LDFLAGS) -o dist/supanow-linux-arm64 .
	GOOS=darwin  GOARCH=amd64  go build $(LDFLAGS) -o dist/supanow-darwin-amd64 .
	GOOS=darwin  GOARCH=arm64  go build $(LDFLAGS) -o dist/supanow-darwin-arm64 .
	GOOS=windows GOARCH=amd64  go build $(LDFLAGS) -o dist/supanow-windows-amd64.exe .

clean:
	rm -rf bin/ dist/
