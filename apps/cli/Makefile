VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.version=$(VERSION) -s -w"

.PHONY: build build-all clean install

build:
	go build $(LDFLAGS) -o bin/mysuperdatabase .

install:
	go build $(LDFLAGS) -o $(GOPATH)/bin/mysuperdatabase .

build-all:
	GOOS=linux   GOARCH=amd64  go build $(LDFLAGS) -o dist/mysuperdatabase-linux-amd64 .
	GOOS=linux   GOARCH=arm64  go build $(LDFLAGS) -o dist/mysuperdatabase-linux-arm64 .
	GOOS=darwin  GOARCH=amd64  go build $(LDFLAGS) -o dist/mysuperdatabase-darwin-amd64 .
	GOOS=darwin  GOARCH=arm64  go build $(LDFLAGS) -o dist/mysuperdatabase-darwin-arm64 .
	GOOS=windows GOARCH=amd64  go build $(LDFLAGS) -o dist/mysuperdatabase-windows-amd64.exe .

clean:
	rm -rf bin/ dist/
