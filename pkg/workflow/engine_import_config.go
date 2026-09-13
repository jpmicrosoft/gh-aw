package workflow

import (
	"encoding/json"
	"fmt"
)

func mainWorkflowSelectsEngine(frontmatter map[string]any) (bool, error) {
	engine, exists := frontmatter["engine"]
	if !exists {
		return false, nil
	}
	encoded, err := json.Marshal(engine)
	if err != nil {
		return false, fmt.Errorf("encoding main engine selection: %w", err)
	}
	return !isModelOnlyEngineJSON(string(encoded)), nil
}

// Match validateSingleEngineSpecification's selection, not an earlier model-only
// preference or engine definition accompanying the selected engine.
func selectedImportedEngineJSON(engines []string) string {
	for _, engine := range engines {
		if engine != "" && !isModelOnlyEngineJSON(engine) && !isEngineDefinitionJSON(engine) {
			return engine
		}
	}
	for _, engine := range engines {
		if isEngineDefinitionJSON(engine) {
			return engine
		}
	}
	return engines[0]
}

// inheritImportedEngineConfig preserves the complete selected engine definition
// when the main workflow only initialized EngineConfig for top-level budgets.
func inheritImportedEngineConfig(existing, imported *EngineConfig) *EngineConfig {
	if imported == nil {
		return existing
	}
	if existing == nil {
		return imported
	}
	if existing.MaxTurns != "" {
		imported.MaxTurns = existing.MaxTurns
	}
	if existing.MaxToolDenials != "" {
		imported.MaxToolDenials = existing.MaxToolDenials
	}
	if existing.MaxAICredits != 0 {
		imported.MaxAICredits = existing.MaxAICredits
	}
	if existing.MaxRuns > 0 {
		imported.MaxRuns = existing.MaxRuns
	}
	if existing.MaxTurnCacheMisses > 0 {
		imported.MaxTurnCacheMisses = existing.MaxTurnCacheMisses
	}
	if existing.MCPSessionTimeout != "" {
		imported.MCPSessionTimeout = existing.MCPSessionTimeout
	}
	if existing.MCPToolTimeout != "" {
		imported.MCPToolTimeout = existing.MCPToolTimeout
	}
	return imported
}
