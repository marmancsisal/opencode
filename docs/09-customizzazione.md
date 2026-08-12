# 09 — Guida alla personalizzazione

> Obiettivo: capire come aggiungere un nuovo agent, come cambiare il modo in cui il sistema decide la difficoltà di un task e come rendere il routing dei modelli completamente personalizzabile.

Questa guida si basa sul comportamento reale del repo:

- le capability descrivono **cosa** fare;
- `policies.yaml` decide **quando** farlo e come interpretare la difficoltà;
- `providers.yaml` decide **con quale modello** eseguirlo;
- `npm run caao:sync` rigenera gli agenti in `.opencode/agent/`.

Il punto importante è questo: in questo sistema un “nuovo agent” non si aggiunge creando a mano un file markdown. Si aggiunge invece una nuova capability, oppure una nuova combinazione capability + pool, e poi si rigenera tutto.

---

## 1. Mappa mentale

Se vuoi cambiare il comportamento, quasi sempre tocchi questi tre file:

| File | Ruolo | Quando modificarlo |
| --- | --- | --- |
| [capabilities.yaml](../.opencode/capabilities.yaml) | Definisce il nuovo lavoro da fare: fase, contesto, output, checklist, mutabilità. | Quando vuoi un nuovo tipo di agent o una nuova capability specializzata. |
| [policies.yaml](../.opencode/policies.yaml) | Decide quali capability servono e come va interpretata la difficoltà. | Quando vuoi cambiare le soglie, la classificazione o l’innesco di planning/review. |
| [providers.yaml](../.opencode/providers.yaml) | Decide quale modello esegue ogni capability e quando fare escalation. | Quando vuoi usare modelli diversi a seconda del task, della complessità o del dominio. |

Il generatore degli agenti è [agents.js](../.opencode/caao/agents.js): legge capability e provider, crea i file in `.opencode/agent/` e li mantiene allineati.

---

## 2. Come aggiungere un nuovo agent

Qui “nuovo agent” significa una nuova capability vera e propria, quindi un nuovo file generato come `caao-<id>.md`.

### Passo 1: definisci la capability

In [capabilities.yaml](../.opencode/capabilities.yaml) aggiungi una voce nuova, per esempio `audit`:

```yaml
capabilities:
  audit:
    title: Audit
    intent: Valuta il cambiamento come un revisore severo, cercando rischi di compatibilità, qualità e manutenzione.
    phase: validate
    context: diff
    confidence_floor: 0.80
    outputs: [findings, verdict]
    worker:
      objective: Individua problemi strutturali o di qualità che non dovrebbero arrivare in produzione.
      checklist:
        - Controlla correttezza, scope e robustezza.
        - Se trovi rischio, spiega perché è rilevante.
        - Non riscrivere il lavoro: valuta il risultato.
      output_contract: findings[{severity,file,issue}], verdict, confidence
```

Regola pratica: se la capability deve modificare file, imposta `mutates: true`. Se deve solo giudicare, lascialo `false`.

### Passo 2: aggiungi il binding nel provider

In [providers.yaml](../.opencode/providers.yaml) aggiungi il binding della nuova capability:

```yaml
bindings:
  audit:
    strategy: highest_quality
    candidates: [opus-5, kimi-code]
```

Se vuoi un modello dedicato, prima aggiungi un nuovo pool e poi lo metti nei candidati:

```yaml
pools:
  gpt-5:
    model: omniroute/github/gpt-5
    tier: heavy
    traits: { reasoning: 5, quality: 5, speed: 3, cost: 4 }
    pricing: { input_per_mtok: 10.00, output_per_mtok: 30.00 }
    temperature: 0.1

profiles:
  heavy:
    strategy: highest_reasoning
    candidates: [opus-5, gpt-5, kimi-code]
```

In questo modo il sistema genera automaticamente una variante dedicata, per esempio `caao-audit--gpt-5.md`.

### Passo 3: falla entrare nel piano

Una capability esiste nel generatore, ma diventa davvero usata solo se una policy la seleziona.

Per esempio, se vuoi che i cambi su API pubbliche o task difficili passino da `audit`, aggiungi una policy in [policies.yaml](../.opencode/policies.yaml):

```yaml
augment:
  - id: add-audit-on-risk
    when:
      any:
        complexity: [high, critical]
        touches: [public_api]
    capabilities: [audit]
    reason: changes on a public or high-risk surface deserve an extra audit pass
```

### Passo 4: rigenera gli agenti

```powershell
npm run caao:sync
```

Ora troverai il nuovo file in `.opencode/agent/`, e il test di drift ti segnalerà subito se il disco non corrisponde più ai registri YAML.

---

## 3. Come cambiare la gestione della difficoltà

La difficoltà non è un numero magico nascosto nel codice. È la combinazione di:

- `intent`
- `complexity`
- `understanding`
- `classification_confidence`
- `touches`
- `changed_files`

La classificazione nasce in [classify.js](../.opencode/caao/classify.js), ma il comportamento lo decidi in [policies.yaml](../.opencode/policies.yaml).

### Le due leve principali

#### 1) Soglie di confidenza semantica

Se vuoi essere più prudente, alza le soglie dei confidence band:

```yaml
classification:
  semantic:
    bands:
      - id: confident
        min: 0.85
        adopt: semantic
      - id: probable
        min: 0.70
        adopt: conservative
      - id: uncertain
        min: 0.50
        adopt: conservative
        raise_complexity: 1
      - id: guessed
        min: 0.00
        adopt: keywords
        raise_complexity: 1
```

Effetto pratico:

- più richieste finiscono in `uncertain` o `guessed`;
- il sistema alza la complessità;
- partono più spesso planning, review e modelli pesanti.

Se invece vuoi più velocità e meno escalation, abbassa le soglie.

#### 2) Regole che trasformano la complessità in capability

Le `base` policy decidono il set minimo. Le `augment` policy aggiungono capacità quando il task è più rischioso.

Esempio: per task critici vuoi sempre planning + review + audit:

```yaml
base:
  - id: critical-work
    when: { complexity: [critical] }
    capabilities: [planning, implementation, review]

augment:
  - id: critical-audit
    when: { complexity: [critical] }
    capabilities: [audit]
    reason: critical work needs an explicit audit gate
```

Questo è il modo giusto per “abbassare o alzare la difficoltà”: non tocchi il codice, tocchi la policy.

---

## 4. Come usare modelli diversi per task diversi

La scelta del modello avviene in [providers.yaml](../.opencode/providers.yaml), non nelle capability.

### Caso semplice: un modello veloce di default, uno pesante solo quando serve

```yaml
bindings:
  implementation:
    strategy: fastest
    candidates: [kimi-code, opus-5]
    overrides:
      - when: { understanding: [uncertain, guessed] }
        profile: heavy
        reason: the request was not understood confidently
      - when: { complexity: [critical] }
        profile: heavy
        reason: critical blast radius outweighs latency and cost
```

Qui il comportamento è chiaro:

- se il task è semplice, resta sul modello veloce;
- se il task è ambiguo o critico, passa al pool heavy;
- il reason finisce nel recap, quindi l’escalation è sempre spiegabile.

### Caso avanzato: aggiungi una strategia tua

Se vuoi un routing più sofisticato, puoi definire una strategia nuova nei pool e poi usarla nei binding.

```yaml
strategies:
  safest:
    rank_by: [-reasoning, -quality, cost]

bindings:
  security:
    strategy: safest
    candidates: [opus-5, kimi-code]
```

La regola è semplice: le capability non decidono il modello, lo fanno i provider con ranking, override e profile.

---

## 5. Se vuoi una personalizzazione davvero totale

Questo è il livello da toccare quando vuoi che il sistema rispecchi il tuo modo di lavorare.

1. Aggiungi o modifica i domini in `policies.yaml` per riconoscere il tuo dominio applicativo.
2. Aggiungi nuove capability in `capabilities.yaml` per separare responsabilità che oggi sono mescolate.
3. Aggiungi pool e profile in `providers.yaml` per avere più modelli con ruoli diversi.
4. Usa `overrides` per fare escalation solo nei casi che ti interessano davvero.
5. Aggiungi o modifica le policy `base`, `augment` e `post` per trasformare la difficoltà in un comportamento esplicito.
6. Rigenera tutto con `npm run caao:sync`.

Se aggiungi una nuova capability, ricordati anche il binding: `config.js` rifiuta configurazioni dove una capability esiste ma non ha un provider.

---

## 6. Esempio completo

Obiettivo: task su `public_api` e `critical` devono passare da un agente di audit dedicato e da un modello pesante.

### `capabilities.yaml`

```yaml
capabilities:
  audit:
    title: Audit
    intent: Valuta rischi di compatibilità e qualità su superfici pubbliche.
    phase: validate
    context: diff
    confidence_floor: 0.80
    outputs: [findings, verdict]
    worker:
      objective: Individua rischi reali, non generici.
      checklist:
        - Controlla comportamento, contratti e regressioni.
        - Marca come bloccante tutto ciò che rompe la superficie pubblica.
      output_contract: findings[{severity,file,issue}], verdict, confidence
```

### `policies.yaml`

```yaml
augment:
  - id: add-audit-on-public-crit
    when:
      all:
        complexity: [critical]
        touches: [public_api]
    capabilities: [audit]
    reason: public critical changes deserve a separate audit capability
```

### `providers.yaml`

```yaml
bindings:
  audit:
    strategy: highest_quality
    candidates: [opus-5, kimi-code]
    overrides:
      - when: { complexity: [critical] }
        profile: heavy
        reason: critical public API changes need the strongest model
```

### Risultato

- la richiesta viene classificata come critica;
- la policy aggiunge `audit`;
- il provider manda `audit` sul modello pesante;
- `npm run caao:sync` genera il relativo file agente;
- il recap finale mostra perché è stato usato quel modello.

---

## 7. Regola di controllo veloce

Se vuoi capire se una modifica è fatta nel posto giusto, usa questa domanda:

- sto cambiando **cosa** fare? allora `capabilities.yaml`;
- sto cambiando **quando** farlo o quanto è rischioso? allora `policies.yaml`;
- sto cambiando **con quale modello** farlo? allora `providers.yaml`.

Se un cambiamento attraversa più di un file, è normale: vuol dire che stai separando bene i ruoli invece di infilare tutto nel codice.

---

## 8. Reference completa dei file YAML

Qui sotto trovi i campi principali di tutti i file YAML del sistema, con una distinzione semplice:

- **Sì** = campo pensato per essere modificato;
- **No** = campo che non va toccato a mano o che è solo derivato;
- **Generato** = il dato viene prodotto da un altro passaggio del sistema;
- **Solo lettura** = serve per capire il comportamento, ma non decide il routing.

### 8.1 `capabilities.yaml`

Questo file descrive **cosa** sa fare il sistema. Non contiene modelli.

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `version` | Sì | Versione dello schema del file. Tienila a `1` finché il formato non cambia. |
| `phases` | Sì | Mappa `phase -> rank`. Serve a ordinare il DAG. Se aggiungi una fase nuova, aggiornala anche in `workflows.execution.phase_order`. |
| `defaults.confidence_floor` | Sì | Soglia predefinita di confidenza per le capability. |
| `defaults.context` | Sì | Contesto predefinito passato ai worker. |
| `defaults.parallelizable` | Sì | Valore predefinito per dire se la capability può correre in parallelo. |
| `defaults.mutates` | Sì | Valore predefinito per dire se la capability modifica file. |
| `capabilities.<id>.title` | Sì | Etichetta leggibile dalla persona. |
| `capabilities.<id>.intent` | Sì | Frase che spiega a cosa serve la capability. |
| `capabilities.<id>.phase` | Sì | Fase logica della capability. Deve esistere in `phases`. |
| `capabilities.<id>.context` | Sì | Quanto contesto riceve il worker: `diff`, `tests`, `touched`, `repo-wide`. |
| `capabilities.<id>.parallelizable` | Sì | Se `false`, la capability diventa una barriera. |
| `capabilities.<id>.mutates` | Sì | Se `true`, il worker generato può editare file. |
| `capabilities.<id>.confidence_floor` | Sì | Soglia minima accettata prima di escalation o review. |
| `capabilities.<id>.requires` | Sì | Hard edge verso altre capability. |
| `capabilities.<id>.may_request` | Sì | Capability che questa può richiedere durante l’esecuzione. |
| `capabilities.<id>.outputs` | Sì | Artefatti dichiarati, usati per documentazione e brief. |
| `capabilities.<id>.worker.objective` | Sì | Missione del worker generato. |
| `capabilities.<id>.worker.checklist` | Sì | Checklist obbligatoria nel brief del worker. |
| `capabilities.<id>.worker.output_contract` | Sì | Forma esatta della risposta attesa. |

Note utili:

- `triage` è speciale: non diventa un nodo normale del DAG, ma resta comunque una capability configurabile.
- Non esistono campi “da non toccare” dentro questo file, ma cambiare `phase` o `requires` può cambiare molto il grafo finale.

### 8.2 `providers.yaml`

Questo file decide **chi** esegue ogni capability.

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `version` | Sì | Versione del registro provider. |
| `defaults.strategy` | Sì | Strategia predefinita per ordinare i candidati. |
| `defaults.timeout_ms` | Sì | Timeout per tentativo. |
| `defaults.max_attempts` | Sì | Numero massimo di tentativi della ladder. |
| `defaults.currency` | Sì | Valuta usata per i costi. |
| `defaults.pricing` | Sì | Prezzo di fallback se un pool non definisce tariffe. |
| `strategies.<id>.rank_by` | Sì | Elenco di trait usati per ordinare i candidati. Prefix `-` = ordine decrescente. |
| `pools.<id>.model` | Sì | Nome del modello registrato in `opencode.json`. |
| `pools.<id>.tier` | Sì | Etichetta `heavy` o `standard` per routing e recap. |
| `pools.<id>.traits` | Sì | Punteggi astratti usati dal ranking. |
| `pools.<id>.pricing` | Sì | Costi reali in USD per milione token. Non entra nel routing. |
| `pools.<id>.temperature` | Sì | Temperatura passata al worker generato. |
| `pools.<id>.context_limit` | Sì | Limite di contesto del pool. |
| `profiles.<id>.strategy` | Sì | Strategia da usare per il profilo. |
| `profiles.<id>.candidates` | Sì | Pool candidati del profilo. |
| `bindings.<capability>.strategy` | Sì | Strategia di default per quella capability. |
| `bindings.<capability>.candidates` | Sì | Pool disponibili per quella capability. |
| `bindings.<capability>.overrides` | Sì | Riconfigurazioni condizionali, usate per l’escalation. |
| `bindings.<capability>.overrides[].when` | Sì | Condizione che decide quando applicare l’override. |
| `bindings.<capability>.overrides[].profile` | Sì | Profili da usare al posto dei candidati base. |
| `bindings.<capability>.overrides[].candidates` | Sì | Lista inline di candidati per l’override. |
| `bindings.<capability>.overrides[].reason` | Sì | Motivazione mostrata nel recap. |
| `budgets.*` | Sì | Soglie e guardrail di spesa mostrati nel dashboard. |

Note utili:

- Il campo `model` è l’unico punto in cui il nome del provider/modello compare davvero.
- `traits.cost` è un numero astratto per il routing; `pricing` è il costo reale per la contabilità.
- `bindings` non è opzionale: ogni capability deve avere almeno un binding.

### 8.3 `policies.yaml`

Questo file decide **quando** una capability serve e come si interpreta la difficoltà.

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `version` | Sì | Versione del registro policy. |
| `classification.semantic.enabled` | Sì | Attiva o disattiva la fusione semantica. |
| `classification.semantic.complexity_order` | Sì | Ordine dei livelli di complessità. |
| `classification.semantic.bands[].id` | Sì | Nome della banda di confidenza. |
| `classification.semantic.bands[].min` | Sì | Soglia minima per entrare nella banda. |
| `classification.semantic.bands[].adopt` | Sì | Come combinare la lettura semantica con quella keyword. |
| `classification.semantic.bands[].raise_complexity` | Sì | Di quanto alzare la complessità quando il sistema è incerto. |
| `classification.semantic.domains` | Sì | Regola di fusione dei domini rilevati. |
| `classification.semantic.on_disagreement` | Sì | Cosa fare se keyword e semantica non concordano. |
| `classification.intents[].id` | Sì | Nome dell’intento classificato. |
| `classification.intents[].keywords` | Sì | Parole chiave che attivano l’intento. |
| `classification.intents[].default` | Sì | Intento di fallback. |
| `classification.complexity[].id` | Sì | Livello di complessità. |
| `classification.complexity[].when` | Sì | Condizione per assegnare quel livello. |
| `classification.complexity[].default` | Sì | Livello di fallback. |
| `classification.domains.*.keywords` | Sì | Keyword per riconoscere un dominio. |
| `classification.domains.*.paths` | Sì | Glob di path per riconoscere un dominio dai file. |
| `base[].id` | Sì | Nome della policy base. |
| `base[].when` | Sì | Quando la policy base scatta. |
| `base[].capabilities` | Sì | Capability iniziali selezionate. |
| `augment[].id` | Sì | Nome della policy additiva. |
| `augment[].when` | Sì | Quando la policy additiva si applica. |
| `augment[].capabilities` | Sì | Capability aggiunte. |
| `augment[].reason` | Sì | Motivazione della composizione. |
| `post[].id` | Sì | Nome della policy post-esecuzione. |
| `post[].when` | Sì | Quando la policy post si attiva. |
| `post[].capabilities` | Sì | Capability da riaprire o aggiungere. |
| `post[].escalate` | Sì | Se `true`, il caso sale di livello. |
| `post[].reason` | Sì | Motivazione mostrata nel trace. |

Signals che puoi usare dentro `when`:

- `intent`
- `complexity`
- `understanding`
- `classification_confidence`
- `touches`
- `changed_files`
- `capabilities`
- `keywords`
- `confidence`
- `findings_blocking`

### 8.4 `workflows.yaml`

Questo file decide **come** eseguire le capability selezionate.

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `version` | Sì | Versione del registro workflow. |
| `default` | Sì | Strategia usata quando nessuna selezione specifica scatta. |
| `selection[].id` | Sì | Nome della regola di selezione. |
| `selection[].when` | Sì | Condizione che attiva la strategia. |
| `selection[].strategy` | Sì | Strategia scelta. |
| `strategies.<id>.description` | Sì | Descrizione umana della strategia. |
| `strategies.<id>.parallel` | Sì | Se la strategia può eseguire nodi in parallelo. |
| `strategies.<id>.max_parallel` | Sì | Ampiezza massima della concorrenza. |
| `strategies.<id>.expand_plan` | Sì | Se il plan può diventare un fan-out espandibile. |
| `strategies.<id>.expand_limit` | Sì | Quanti sottotask al massimo può creare. |
| `strategies.<id>.merge` | Sì | Modalità di merge finale. |
| `execution.phase_order` | Sì | Ordine delle fasi del grafo. |
| `execution.phase_depends_on` | Sì | Dipendenze fra fasi. |
| `execution.worker_isolation` | Sì | Se i worker non devono parlarsi tra loro. |
| `confidence.accept` | Sì | Soglia oltre la quale la confidenza è considerata sufficiente. |
| `confidence.review` | Sì | Soglia sotto cui si mantiene la validazione. |
| `confidence.escalate` | Sì | Soglia sotto cui si attiva l’advisor o l’human escalation. |
| `retry.max_attempts` | Sì | Numero massimo di tentativi complessivi. |
| `retry.on` | Sì | Tipi di errore che attivano la ladder. |
| `retry.ladder[].action` | Sì | Azione di recovery: retry, switch provider, escalate. |
| `retry.ladder[].reason` | Sì | Spiegazione della recovery. |
| `merge.strategy` | Sì | Come unire i risultati finali. |
| `merge.order_by` | Sì | Ordine di merge. |
| `merge.conflict` | Sì | Cosa fare se c’è un conflitto. |
| `merge.detect` | Sì | Regole di conflitto da rilevare. |
| `context.scopes.*.description` | Sì | Descrizione del tipo di contesto. |
| `context.scopes.*.include` | Sì | Cosa include quel contesto. |
| `context.budget.max_files_per_worker` | Sì | Numero massimo di file per worker. |
| `context.budget.max_bytes_per_worker` | Sì | Dimensione massima del contesto. |
| `validation.gates.*.blocking` | Sì | Se il gate è bloccante. |
| `validation.gates.*.on_fail` | Sì | Cosa fare se la validazione fallisce. |
| `validation.max_reopen_cycles` | Sì | Quante volte riaprire un nodo dopo un gate fallito. |

### 8.5 `catalog.yaml`

Questo file non decide il routing dei modelli, ma gestisce MCP, skills e context tools.

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `version` | Sì | Versione del catalogo aziendale. |
| `defaults.scope` | Sì | Scope predefinito per le voci del catalogo. |
| `defaults.enabled` | Sì | Stato iniziale predefinito. |
| `mcp[]` | Sì | Elenco dei server MCP disponibili. |
| `skills[]` | Sì | Elenco delle skill distribuite ai worker. |
| `context_tools[]` | Sì | Elenco dei tool di contesto/compressione. |

Campi MCP più comuni:

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `mcp[].id` | Sì | Identificatore unico del server. |
| `mcp[].title` | Sì | Nome leggibile. |
| `mcp[].description` | Sì | A cosa serve il server. |
| `mcp[].kind` | Sì | `local` o `remote`. |
| `mcp[].enabled` | Sì | Se il server è attivo. |
| `mcp[].scope` | Sì | Dove è valido: tutto il mondo, repo specifici o team. |
| `mcp[].owner` | Sì | Team responsabile. |
| `mcp[].version` | Sì | Versione del server o del connettore. |
| `mcp[].command` | Sì | Comando locale da eseguire per avviare il server. |
| `mcp[].environment` | Sì | Variabili richieste dal server. Usa sempre placeholder `{env:NAME}`. |
| `mcp[].url` | Sì | Endpoint remoto quando il server è `remote`. |
| `mcp[].headers` | Sì | Header HTTP da inviare al server remoto. |
| `mcp[].tools` | Sì | Elenco dei tool esposti dal server. |
| `mcp[].notes` | Sì | Note operative o vincoli. |

Campi skill più comuni:

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `skills[].id` | Sì | Identificatore unico della skill. |
| `skills[].title` | Sì | Nome leggibile della skill. |
| `skills[].description` | Sì | Spiegazione breve del contenuto. |
| `skills[].enabled` | Sì | Se la skill è attiva. |
| `skills[].scope` | Sì | Dove è applicata. |
| `skills[].owner` | Sì | Team o persona responsabile. |
| `skills[].version` | Sì | Versione della skill. |
| `skills[].capabilities` | Sì | Capability che possono usare la skill. |
| `skills[].file` | Sì | File markdown della skill da distribuire. |
| `skills[].notes` | Sì | Vincoli, obblighi o note di rollout. |

Campi context tool più comuni:

| Campo | Modificabile? | Descrizione |
| --- | --- | --- |
| `context_tools[].id` | Sì | Identificatore unico del tool. |
| `context_tools[].title` | Sì | Nome leggibile. |
| `context_tools[].description` | Sì | Descrizione breve del tool. |
| `context_tools[].category` | Sì | Categoria funzionale, ad esempio `compression` o `knowledge_graph`. |
| `context_tools[].enabled` | Sì | Se il tool è attivo. |
| `context_tools[].scope` | Sì | Dove è disponibile. |
| `context_tools[].owner` | Sì | Team responsabile. |
| `context_tools[].version` | Sì | Versione del tool. |
| `context_tools[].homepage` | Sì | Pagina di riferimento o progetto upstream. |
| `context_tools[].install` | Sì | Comando di installazione. |
| `context_tools[].mode` | Sì | Modalità operativa del tool. |
| `context_tools[].mcp.kind` | Sì | MCP locale o remoto usato per esporre il tool. |
| `context_tools[].mcp.command` | Sì | Comando del server MCP del tool. |
| `context_tools[].mcp.environment` | Sì | Variabili necessarie al server MCP. |
| `context_tools[].tools` | Sì | Tool resi disponibili. |
| `context_tools[].savings` | Sì | Regole per leggere i token risparmiati. |
| `context_tools[].notes` | Sì | Note operative, limiti o avvertenze. |

### Cosa non modificare a mano

Queste superfici non sono YAML, ma sono comunque parte del flusso di configurazione e spesso vengono confuse con file da editare manualmente:

- `.opencode/agent/*.md` è generato da `npm run caao:sync`.
- `.opencode/opencode.json` è proiettato da `npm run caao:catalog`.
- `distribution.json` è gestito dal flusso di update e distribuzione.

Se vuoi cambiare il comportamento, cambia i registri YAML sorgente e rigenera.

---

## 9. Come aggiungere e gestire MCP, skills e context tools

Questa è la parte pratica per estendere il catalogo aziendale.

### 9.1 Aggiungere un nuovo server MCP

Se vuoi esporre un nuovo server MCP, aggiungi una voce in `catalog.yaml` sotto `mcp`.

Esempio locale:

```yaml
mcp:
  - id: jira
    title: Jira
    description: Ticket lookup for the triage capability.
    kind: remote
    enabled: true
    scope: all
    owner: delivery-team
    version: 0.3.0
    url: https://mcp.example.com/jira
    tools: [get_issue, search_issues]
```

Esempio con comando locale e variabili d’ambiente:

```yaml
mcp:
  - id: github
    title: GitHub
    kind: local
    enabled: true
    scope: all
    command: [npx, -y, "@modelcontextprotocol/server-github"]
    environment:
      GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_TOKEN}"
    tools: [search_repositories, get_issue, create_pull_request]
```

Regole pratiche:

- usa sempre `{env:NAME}` per segreti e credenziali;
- non salvare token veri nel catalogo;
- compila `tools` con i nomi esatti che il server espone;
- se il server è disattivato, metti `enabled: false` invece di cancellarlo.

### 9.2 Aggiungere una skill

Una skill è un file markdown distribuito ai worker con uno scope e un insieme di capability abilitate.

Passi consigliati:

1. Crea il file markdown della skill nel percorso previsto dal catalogo, ad esempio `skills/acme-security-baseline.md`.
2. Aggiungi una voce in `catalog.yaml` sotto `skills`.
3. Collega la skill alle capability che la devono usare.
4. Rigenera il catalogo.

Esempio:

```yaml
skills:
  - id: acme-security-baseline
    title: Security baseline
    description: OWASP-derived checklist, secret handling rules and the crypto approval matrix.
    enabled: true
    scope: all
    owner: security-team
    version: 2.2.0
    capabilities: [security, review, implementation]
    file: skills/acme-security-baseline.md
    notes: Mandatory — the security capability refuses to sign off without it.
```

### 9.3 Aggiungere un context tool

I context tool servono ad arricchire il contesto o comprimere output. Hanno anche la parte MCP dietro le quinte.

Esempio:

```yaml
context_tools:
  - id: graphify
    title: Graphify
    description: Local AST-backed repository knowledge graph for query-first codebase context.
    category: knowledge_graph
    enabled: true
    scope: all
    owner: platform-team
    version: latest
    homepage: https://github.com/Graphify-Labs/graphify
    install: uv tool install "graphifyy[mcp]"
    setup: graphify opencode install
    refresh: graphify extract . --code-only
    mcp:
      kind: local
      command: [python, -m, graphify.serve, graphify-out/graph.json]
      environment:
        GRAPHIFY_QUERY_LOG_DISABLE: "1"
    tools: [query_graph, get_node, get_neighbors, shortest_path]
```

### 9.4 Dopo una modifica

Quando cambi `catalog.yaml`, fai sempre questo:

```powershell
npm run caao:catalog
npm run caao:doctor
```

Il primo comando rigenera la proiezione usata da opencode. Il secondo ti dice subito se il server, il comando o le variabili richieste sono davvero disponibili.

### 9.5 Regola semplice per non sbagliare

Se stai aggiungendo qualcosa che un agente deve usare durante il lavoro:

- se è un server esterno o locale, va in `mcp`;
- se è un manuale operativo per i worker, va in `skills`;
- se è un tool per comprimere, cercare o arricchire il contesto, va in `context_tools`.

Se vuoi, nel prossimo passaggio posso anche trasformare questa sezione in una tabella ancora più compatta, oppure adattarla al tuo caso reale con esempi su MCP GitHub, skill di review e un context tool di knowledge graph.