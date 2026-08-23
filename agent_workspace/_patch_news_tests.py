from pathlib import Path

files = {
    r"C:\WorkProjects\Multi-Agent-AI-Trading-Platform\src\server\news\NewsPredictionLedger.test.ts": [
        ("expect(rows[0].newsAgentMode).toBe('CATALYST_ONLY'); // real repo config default",
         "expect(rows[0].newsAgentMode).toBe('ACTIVE_VOTE'); // real repo config default (DEF-TODAY-05)"),
    ],
    r"C:\WorkProjects\Multi-Agent-AI-Trading-Platform\src\server\config\deskIntelligence.test.ts": [
        ("expect(deskIntelligence.newsAgentMode).toBe('CATALYST_ONLY');",
         "expect(deskIntelligence.newsAgentMode).toBe('ACTIVE_VOTE');"),
    ],
    r"C:\WorkProjects\Multi-Agent-AI-Trading-Platform\src\server\config\deskIntelligence.newsAgentMode.test.ts": [
        ("  it('derives false/true correctly from the real repo config default (CATALYST_ONLY)', async () => {\n",
         "  it('derives false/true correctly from the real repo config default (ACTIVE_VOTE)', async () => {\n"),
        ("    expect(deskIntelligence.newsAgentMode).toBe('CATALYST_ONLY');\n",
         "    expect(deskIntelligence.newsAgentMode).toBe('ACTIVE_VOTE');\n"),
    ],
}

# Also need to fix emitsTradeIdeas expectations in newsAgentMode.test.ts
p = Path(r"C:\WorkProjects\Multi-Agent-AI-Trading-Platform\src\server\config\deskIntelligence.newsAgentMode.test.ts")
text = p.read_text(encoding="utf-8")
print("--- newsAgentMode.test around default ---")
idx = text.find("derives false/true")
print(text[idx:idx+500])
