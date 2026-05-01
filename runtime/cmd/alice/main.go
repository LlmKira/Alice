// alice — Alice 部署体检工具
//
// 用法:
//
//	alice doctor   # 环境诊断
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

var version = "1.0.0"

const envFile = ".env"
const requiredNodeMajor = 22

var requiredSystemBinaries = []string{"irc", "self", "alice-pkg"}

func main() {
	if len(os.Args) < 2 {
		doctor()
		return
	}

	cmd := os.Args[1]
	switch cmd {
	case "doctor":
		doctor()
	case "version":
		fmt.Printf("alice v%s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	_, _ = os.Stdout.WriteString(`Alice — 部署体检工具

用法:
  alice
  alice doctor

命令:
  doctor    环境诊断（默认命令）
  version   显示版本
  help      显示帮助

部署:
  cd /usr/local/lib/alice
  cp runtime/.env.example runtime/.env
  alice doctor
  pm2 start ecosystem.config.cjs
`)
}

func doctor() {
	fmt.Println("🔍 Alice 环境诊断")
	fmt.Println()

	ok := true
	runtimeDir := findRuntimeDir()
	envPath := findEnvFile(runtimeDir)

	// Go 版本
	fmt.Print("  Go 版本: ")
	if hasCommand("go") {
		out, _ := exec.Command("go", "version").Output()
		fmt.Printf("✅ %s\n", strings.Fields(string(out))[2])
	} else {
		fmt.Println("⚠️  未安装 (可选，用于编译)")
	}

	// Node.js
	fmt.Print("  Node.js: ")
	if hasCommand("node") {
		out, _ := exec.Command("node", "--version").Output()
		version := strings.TrimSpace(string(out))
		major, err := parseNodeMajor(version)
		switch {
		case err != nil:
			fmt.Printf("⚠️  %s（无法解析版本）\n", version)
			ok = false
		case major < requiredNodeMajor:
			fmt.Printf("❌ %s（需要 v%d+）\n", version, requiredNodeMajor)
			ok = false
		default:
			fmt.Printf("✅ %s\n", version)
		}
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// Runtime
	fmt.Print("  Runtime: ")
	if runtimeDir != "" {
		fmt.Printf("✅ %s\n", absPath(runtimeDir))
	} else {
		fmt.Println("❌ 未找到 runtime 目录")
		ok = false
	}

	// System bin
	fmt.Print("  System bin: ")
	if runtimeDir == "" {
		fmt.Println("⚠️  跳过（未定位 runtime）")
	} else {
		systemBinDir := findSystemBinDir(runtimeDir)
		if missing := findMissingSystemBinaries(systemBinDir); len(missing) > 0 {
			fmt.Printf("❌ %s（缺少 %s）\n", absPath(systemBinDir), strings.Join(missing, ", "))
			ok = false
		} else {
			fmt.Printf("✅ %s\n", absPath(systemBinDir))
		}
	}

	// tsx
	fmt.Print("  tsx: ")
	if runtimeDir == "" {
		fmt.Println("⚠️  跳过（未定位 runtime）")
	} else if tsx := findTsxBinary(runtimeDir); tsx != "" {
		fmt.Printf("✅ %s\n", tsx)
	} else if hasCommand("pnpm") {
		fmt.Println("⚠️  未找到本地 tsx，将回退到 pnpm exec tsx")
		ok = false
	} else {
		fmt.Println("❌ 未找到 tsx 运行器")
		ok = false
	}

	// Docker
	fmt.Print("  Docker: ")
	if hasCommand("docker") {
		if out, err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").Output(); err == nil {
			fmt.Printf("✅ %s\n", strings.TrimSpace(string(out)))
		} else {
			fmt.Println("❌ 已安装但未运行")
			ok = false
		}
	} else {
		fmt.Println("❌ 未安装（skill 执行必需）")
		ok = false
	}

	// SQLite
	fmt.Print("  SQLite: ")
	if hasCommand("sqlite3") {
		out, _ := exec.Command("sqlite3", "--version").Output()
		fmt.Printf("✅ %s\n", strings.Fields(string(out))[0])
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// PM2
	fmt.Print("  PM2: ")
	if hasCommand("pm2") {
		out, _ := exec.Command("pm2", "--version").Output()
		fmt.Printf("✅ %s\n", strings.TrimSpace(string(out)))
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// better-sqlite3 / mtcute
	fmt.Print("  Native modules: ")
	if runtimeDir == "" || !hasCommand("node") {
		fmt.Println("⚠️  跳过（缺少 runtime 或 Node.js）")
	} else if err := checkNodeRuntime(runtimeDir); err != nil {
		fmt.Printf("❌ %s\n", err)
		ok = false
	} else {
		fmt.Println("✅ better-sqlite3 + @mtcute/node")
	}

	// Skills
	fmt.Print("  Skills: ")
	if skillDir := findSkillDir(runtimeDir); skillDir != "" {
		files, _ := os.ReadDir(skillDir)
		fmt.Printf("✅ %d 个\n", len(files))
	} else {
		fmt.Println("⚠️  未找到")
	}

	// 配置文件
	fmt.Print("  配置: ")
	if envPath != "" {
		fmt.Printf("✅ %s\n", absPath(envPath))
		envVars, err := loadEnvFile(envPath)
		fmt.Print("  配置项: ")
		if err != nil {
			fmt.Printf("❌ %v\n", err)
			ok = false
		} else {
			check := validateEnvFile(envVars)
			switch {
			case len(check.Missing) > 0 || len(check.Invalid) > 0:
				parts := make([]string, 0, len(check.Missing)+len(check.Invalid))
				if len(check.Missing) > 0 {
					parts = append(parts, "缺少 "+strings.Join(check.Missing, ", "))
				}
				if len(check.Invalid) > 0 {
					parts = append(parts, "非法 "+strings.Join(check.Invalid, ", "))
				}
				fmt.Printf("❌ %s\n", strings.Join(parts, "；"))
				ok = false
			default:
				fmt.Println("✅ 关键字段齐全")
			}
			if len(check.LegacyOnly) > 0 {
				fmt.Print("  旧字段: ")
				fmt.Printf("❌ 检测到 %s；Alice 现在只读取 LLM_*\n", strings.Join(check.LegacyOnly, ", "))
				ok = false
			} else if len(check.LegacySeen) > 0 {
				fmt.Print("  旧字段: ")
				fmt.Printf("⚠️  检测到 %s；当前以 LLM_* 为准\n", strings.Join(check.LegacySeen, ", "))
			}
		}
	} else {
		fmt.Println("⚠️  未找到 .env，请复制 runtime/.env.example 到 runtime/.env")
		fmt.Println("  配置项: ⚠️  跳过")
	}

	fmt.Println()
	if ok {
		fmt.Println("✅ 环境检查通过")
		return
	}
	fmt.Println("❌ 环境不完整，请安装缺失的依赖")
	os.Exit(1)
}

// ── 辅助函数 ───────────────────────────────────────────────────────

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func absPath(path string) string {
	abs, _ := filepath.Abs(path)
	return abs
}

func parseNodeMajor(version string) (int, error) {
	version = strings.TrimSpace(strings.TrimPrefix(version, "v"))
	parts := strings.SplitN(version, ".", 2)
	return strconv.Atoi(parts[0])
}

func findRuntimeDir() string {
	// 1. 环境变量
	if dir := os.Getenv("ALICE_RUNTIME_DIR"); dir != "" {
		if _, err := os.Stat(filepath.Join(dir, "src/index.ts")); err == nil {
			return dir
		}
	}

	// 2. 全局安装位置
	globalDirs := []string{
		"/usr/local/lib/alice/runtime",
		"/usr/lib/alice/runtime",
	}
	for _, dir := range globalDirs {
		if _, err := os.Stat(filepath.Join(dir, "src/index.ts")); err == nil {
			return dir
		}
	}

	// 3. 当前目录
	if _, err := os.Stat("src/index.ts"); err == nil {
		return "."
	}
	// 4. runtime 子目录
	if _, err := os.Stat("runtime/src/index.ts"); err == nil {
		return "runtime"
	}
	// 5. 父目录
	if _, err := os.Stat("../src/index.ts"); err == nil {
		return ".."
	}

	return ""
}

func findSystemBinDir(runtimeDir string) string {
	if dir := os.Getenv("ALICE_SYSTEM_BIN_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(runtimeDir, "dist", "bin")
}

func findMissingSystemBinaries(systemBinDir string) []string {
	missing := make([]string, 0, len(requiredSystemBinaries))
	for _, name := range requiredSystemBinaries {
		path := filepath.Join(systemBinDir, name)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			missing = append(missing, name)
		}
	}
	return missing
}

func findSkillDir(runtimeDir string) string {
	candidates := make([]string, 0, 6)
	if runtimeDir != "" {
		candidates = append(candidates,
			filepath.Join(runtimeDir, "dist", "bin"),
			filepath.Join(runtimeDir, "skills", "store"),
		)
	}
	candidates = append(candidates,
		"dist/bin",
		"skills/store",
		"/usr/local/lib/alice/runtime/dist/bin",
		"/usr/local/lib/alice/skills",
	)
	for _, dir := range candidates {
		if _, err := os.Stat(dir); err == nil {
			return dir
		}
	}
	return ""
}

func findEnvFile(runtimeDir string) string {
	candidates := []string{envFile}
	if runtimeDir != "" {
		candidates = append([]string{filepath.Join(runtimeDir, envFile)}, candidates...)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func loadEnvFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	env := make(map[string]string)
	scanner := bufio.NewScanner(file)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		idx := strings.IndexRune(line, '=')
		if idx <= 0 {
			return nil, fmt.Errorf("%s:%d: 无效行 %q", path, lineNo, line)
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		value = strings.Trim(value, `"'`)
		env[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return env, nil
}

type envValidation struct {
	Missing    []string
	Invalid    []string
	LegacySeen []string
	LegacyOnly []string
}

func validateEnvFile(env map[string]string) envValidation {
	result := envValidation{}
	required := []string{"TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_PHONE", "LLM_API_KEY"}
	for _, key := range required {
		if strings.TrimSpace(env[key]) == "" {
			result.Missing = append(result.Missing, key)
		}
	}
	if apiID := strings.TrimSpace(env["TELEGRAM_API_ID"]); apiID != "" {
		if _, err := strconv.Atoi(apiID); err != nil {
			result.Invalid = append(result.Invalid, "TELEGRAM_API_ID")
		}
	}
	legacy := map[string]string{
		"OPENAI_API_KEY":  "LLM_API_KEY",
		"OPENAI_BASE_URL": "LLM_BASE_URL",
		"OPENAI_MODEL":    "LLM_MODEL",
	}
	for oldKey, newKey := range legacy {
		if strings.TrimSpace(env[oldKey]) == "" {
			continue
		}
		result.LegacySeen = append(result.LegacySeen, oldKey)
		if strings.TrimSpace(env[newKey]) == "" {
			result.LegacyOnly = append(result.LegacyOnly, oldKey)
		}
	}
	sort.Strings(result.Missing)
	sort.Strings(result.Invalid)
	sort.Strings(result.LegacySeen)
	sort.Strings(result.LegacyOnly)
	return result
}

func findTsxBinary(runtimeDir string) string {
	seen := make(map[string]struct{})
	for _, root := range candidateNodeRoots(runtimeDir) {
		if root == "" {
			continue
		}
		candidate := filepath.Clean(filepath.Join(root, "node_modules", ".bin", "tsx"))
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func candidateNodeRoots(runtimeDir string) []string {
	runtimeAbs := absPath(runtimeDir)
	return []string{
		runtimeDir,
		filepath.Dir(runtimeDir),
		runtimeAbs,
		filepath.Dir(runtimeAbs),
		".",
		"..",
	}
}

func checkNodeRuntime(runtimeDir string) error {
	cmd := exec.Command(
		"node",
		"--input-type=module",
		"-e",
		"await import('better-sqlite3'); await import('@mtcute/node');",
	)
	cmd.Dir = runtimeDir
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if msg == "" {
		msg = err.Error()
	}
	if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
		msg = msg[:idx]
	}
	return fmt.Errorf("%s", msg)
}
