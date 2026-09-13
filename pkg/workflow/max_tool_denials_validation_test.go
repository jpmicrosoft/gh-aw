//go:build !integration

package workflow

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateMaxToolDenialsSupport(t *testing.T) {
	t.Parallel()

	compiler := NewCompiler()
	registry := GetGlobalEngineRegistry()

	copilotEngine, err := registry.GetEngine("copilot")
	require.NoError(t, err)

	claudeEngine, err := registry.GetEngine("claude")
	require.NoError(t, err)

	tests := []struct {
		name        string
		frontmatter map[string]any
		engine      CodingAgentEngine
		expectError string
	}{
		{
			name: "no max-tool-denials",
			frontmatter: map[string]any{
				"engine": "claude",
			},
			engine: claudeEngine,
		},
		{
			name: "copilot sdk with max-tool-denials",
			frontmatter: map[string]any{
				"engine": map[string]any{
					"id":          "copilot",
					"copilot-sdk": true,
				},
				"max-tool-denials": 6,
			},
			engine: copilotEngine,
		},
		{
			name: "copilot without sdk rejects max-tool-denials",
			frontmatter: map[string]any{
				"engine": map[string]any{
					"id": "copilot",
				},
				"max-tool-denials": 6,
			},
			engine:      copilotEngine,
			expectError: "requires Copilot SDK mode",
		},
		{
			name: "non-copilot rejects max-tool-denials",
			frontmatter: map[string]any{
				"engine":           "claude",
				"max-tool-denials": 6,
			},
			engine:      claudeEngine,
			expectError: "does not support max-tool-denials",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, config, _ := compiler.ExtractEngineConfig(tt.frontmatter)
			err := compiler.validateMaxToolDenialsSupport(config, tt.engine)
			if tt.expectError == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, tt.expectError)
		})
	}
}

func TestMaxToolDenialsUsesEffectiveImportedEngine(t *testing.T) {
	for _, test := range []struct {
		name    string
		engine  string
		sdk     bool
		wantErr string
	}{
		{name: "SDK import", engine: "copilot", sdk: true},
		{name: "CLI import", engine: "copilot", wantErr: "requires Copilot SDK mode"},
		{name: "non-Copilot import", engine: "claude", wantErr: "does not support max-tool-denials"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			shared := fmt.Sprintf("---\nengine:\n  id: %s\n  copilot-sdk: %t\n---\n\nShared engine.\n", test.engine, test.sdk)
			require.NoError(t, os.WriteFile(filepath.Join(dir, "shared.md"), []byte(shared), 0o600))
			filename := filepath.Join(dir, "workflow.md")
			main := "---\non: workflow_dispatch\nimports: [shared.md]\nmax-tool-denials: 1\n---\n\nReview the repository.\n"
			require.NoError(t, os.WriteFile(filename, []byte(main), 0o600))
			data, err := NewCompiler().ParseWorkflowFile(filename)
			if test.wantErr != "" {
				require.ErrorContains(t, err, test.wantErr)
				return
			}
			require.NoError(t, err)
			require.True(t, data.EngineConfig.CopilotSDK)
			require.Equal(t, "1", data.EngineConfig.MaxToolDenials)
		})
	}
}
