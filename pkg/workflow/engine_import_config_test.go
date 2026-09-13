//go:build !integration

package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/github/gh-aw/pkg/parser"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGoRepositoryProfileImportedWithTopLevelBudgets(t *testing.T) {
	dir := t.TempDir()
	shared := `---
engine:
  id: copilot
  copilot-sdk: true
  tool-profile: go-repository
  model: gpt-5
  harness:
    max-retries: 0
max-turns: 20
max-tool-denials: 9
max-ai-credits: 2000
max-turn-cache-misses: 8
---

Shared engine.
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "shared.md"), []byte(shared), 0o600))
	markdown := `---
on: workflow_dispatch
imports: [shared.md]
max-turns: 4
max-tool-denials: 1
max-ai-credits: 1000
max-turn-cache-misses: 2
tools:
  bash: false
  cli-proxy: false
safe-outputs:
  create-pull-request:
---

Update the repository.
`
	filename := filepath.Join(dir, "workflow.md")
	require.NoError(t, os.WriteFile(filename, []byte(markdown), 0o600))
	data, err := NewCompiler().ParseWorkflowFile(filename)
	require.NoError(t, err)
	require.NoError(t, validateCopilotToolProfile(data))
	config := data.EngineConfig
	assert.Equal(t, "copilot", config.ID)
	assert.True(t, config.CopilotSDK)
	assert.Equal(t, "go-repository", config.ToolProfile)
	assert.Equal(t, "0", config.HarnessMaxRetries)
	assert.Equal(t, "gpt-5", data.Model)
	assert.Equal(t, "4", config.MaxTurns)
	assert.Equal(t, "1", config.MaxToolDenials)
	assert.Equal(t, int64(1000), config.MaxAICredits)
	assert.Equal(t, 4, config.MaxRuns, "top-level max-turns must retain precedence over the imported run budget")
	assert.Equal(t, 2, config.MaxTurnCacheMisses)
	assert.True(t, data.BashDisabled)
}

func TestGoRepositoryProfileLegacyMaxRunsAliasPrecedence(t *testing.T) {
	markdown := strings.Replace(goRepositoryProfileTestMarkdown, "on: workflow_dispatch\n",
		"on: workflow_dispatch\nstrict: false\nmax-turns: 4\nmax-runs: 3\n", 1)
	data := parseGoRepositoryProfileTestSource(t, markdown)
	require.NoError(t, validateCopilotToolProfile(data))
	assert.Equal(t, "4", data.EngineConfig.MaxTurns)
	assert.Equal(t, 4, data.EngineConfig.MaxRuns, "max-turns must retain precedence over the deprecated max-runs alias")
}

func TestGoRepositoryProfileImportSelectsNamedEngineAfterPreferences(t *testing.T) {
	compiler := NewCompiler()
	result := &parser.FrontmatterResult{Frontmatter: map[string]any{"max-ai-credits": 1000}}
	imports := &parser.ImportsResult{MergedEngines: []string{
		`{"model":"small"}`,
		`{"id":"copilot","copilot-sdk":true,"tool-profile":"go-repository","model":"gpt-5","harness":{"max-retries":0}}`,
	}}
	setting, config, model, _, err := compiler.resolveEngineFromIncludesAndImports(
		result, t.TempDir(), imports, "", &EngineConfig{MaxAICredits: 1000}, "preferred-model",
	)
	require.NoError(t, err)
	assert.Equal(t, "copilot", setting)
	require.NotNil(t, config)
	assert.True(t, config.CopilotSDK)
	assert.Equal(t, "go-repository", config.ToolProfile)
	assert.Equal(t, int64(1000), config.MaxAICredits)
	assert.Equal(t, "0", config.HarnessMaxRetries)
	assert.Equal(t, "preferred-model", model, "main model precedence must not change")
}

func TestGoRepositoryProfileImportPreservesMainModelAndMCPPreferences(t *testing.T) {
	compiler := NewCompiler()
	result := &parser.FrontmatterResult{Frontmatter: map[string]any{
		"engine":         map[string]any{"model": "preferred"},
		"max-ai-credits": 1000,
	}}
	imports := &parser.ImportsResult{MergedEngines: []string{
		`{"id":"copilot","copilot-sdk":true,"tool-profile":"go-repository","model":"gpt-5"}`,
	}}
	_, config, model, _, err := compiler.resolveEngineFromIncludesAndImports(
		result, t.TempDir(), imports, "",
		&EngineConfig{MaxAICredits: 1000, MCPSessionTimeout: "4h", MCPToolTimeout: "90s"}, "preferred",
	)
	require.NoError(t, err)
	require.NotNil(t, config)
	assert.Equal(t, "go-repository", config.ToolProfile)
	assert.True(t, config.CopilotSDK)
	assert.Equal(t, int64(1000), config.MaxAICredits)
	assert.Equal(t, "4h", config.MCPSessionTimeout)
	assert.Equal(t, "90s", config.MCPToolTimeout)
	assert.Equal(t, "preferred", model)
}

func TestInheritImportedEngineConfigPreservesBudgetsAndSDKFields(t *testing.T) {
	existing := &EngineConfig{
		MaxTurns: "4", MaxToolDenials: "1", MaxAICredits: -1, MaxRuns: 3, MaxTurnCacheMisses: 2,
	}
	imported := &EngineConfig{
		ID: "copilot", CopilotSDK: true, ToolProfile: "go-repository",
		Driver: "custom-driver.cjs", HarnessMaxRetries: "0",
		MaxTurns: "20", MaxToolDenials: "9", MaxAICredits: 2000, MaxRuns: 10, MaxTurnCacheMisses: 8,
	}
	config := inheritImportedEngineConfig(existing, imported)
	assert.Equal(t, existing.MaxTurns, config.MaxTurns)
	assert.Equal(t, existing.MaxToolDenials, config.MaxToolDenials)
	assert.Equal(t, existing.MaxAICredits, config.MaxAICredits)
	assert.Equal(t, existing.MaxRuns, config.MaxRuns)
	assert.Equal(t, existing.MaxTurnCacheMisses, config.MaxTurnCacheMisses)
	assert.True(t, config.CopilotSDK)
	assert.Equal(t, "go-repository", config.ToolProfile)
	assert.Equal(t, "custom-driver.cjs", config.Driver, "retain incompatible imported fields so validation can reject them")
	assert.Equal(t, "0", config.HarnessMaxRetries)
	assert.Same(t, config, inheritImportedEngineConfig(nil, config))
	assert.Same(t, existing, inheritImportedEngineConfig(existing, nil))
}
