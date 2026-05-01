# Alice Skills - Go 静态编译
#
# 用法:
#   make          # 编译所有 skill
#   make install  # 编译并安装到 /usr/local/bin
#   make clean    # 清理

GO := go
GOFLAGS := CGO_ENABLED=0
LDFLAGS := -ldflags="-s -w"
OUTDIR := dist/bin
PREFIX ?= /usr/local

# 所有 skill
SKILLS := hitokoto kfc fabing luck countdown trending weather video music \
          repeat-message google visit selfcheck calendar

.PHONY: all clean install $(SKILLS)

all: $(OUTDIR) $(SKILLS) alice

$(OUTDIR):
	mkdir -p $(OUTDIR)

alice: $(OUTDIR)
	$(GOFLAGS) $(GO) build $(LDFLAGS) -o $(OUTDIR)/alice ./cmd/alice

$(SKILLS): $(OUTDIR)
	$(GOFLAGS) $(GO) build $(LDFLAGS) -o $(OUTDIR)/$@ ./cmd/skills/$@
	pnpm exec tsx scripts/wrap-skill-bin.ts $(OUTDIR)/$@ $@

clean:
	rm -rf $(OUTDIR)

# 安装到系统
install: all
	install -d $(PREFIX)/bin
	install -m 755 $(OUTDIR)/* $(PREFIX)/bin/
