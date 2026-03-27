# Quiz multiplayer com HTTP + AJAX

Projeto minimo de quiz multiplayer no browser usando apenas tecnologias web simples:

- Node.js com servidor HTTP nativo
- SQLite embutido no Node para guardar salas e pontuacoes
- HTML, CSS e JavaScript no cliente
- Long polling com `GET /updates`
- Estado do jogo ativo mantido em memoria
- Perguntas carregadas de um ficheiro JSON

## Como correr

```bash
node server.js
```

Depois abre [http://localhost:3000](http://localhost:3000).

Na interface podes escolher logo entre:

- modo anfitriao, para criar sala e controlar o quiz
- modo jogador, para entrar com codigo e responder

Tambem podes abrir diretamente:

- [http://localhost:3000/host](http://localhost:3000/host)
- [http://localhost:3000/player](http://localhost:3000/player)

## Fluxo implementado

1. O anfitriao cria uma sala em `POST /create-room`.
2. Os jogadores entram pela rota `POST /join`.
3. O anfitriao inicia o jogo com `POST /start`.
4. Cada jogador responde em `POST /answer`.
5. O cliente faz long polling em `GET /updates?gameCode=ABCD&since=123`.
6. O anfitriao avanca com `POST /next-question` ate ao fim.

## Estrutura

- `server.js`: servidor, salas, pontuacao e long polling
- `data/game.db`: base de dados SQLite com salas e jogadores
- `data/questions.json`: perguntas editaveis do quiz
- `public/index.html`: pagina inicial de escolha
- `public/host.html`: pagina dedicada ao anfitriao
- `public/player.html`: pagina dedicada ao jogador
- `public/shared.js`: utilitarios partilhados do frontend
- `public/host.js`: logica AJAX do anfitriao
- `public/player.js`: logica AJAX do jogador
- `public/styles.css`: estilos da interface

## Como editar perguntas

Altera o ficheiro `data/questions.json`.

Cada pergunta segue este formato:

```json
{
  "id": 1,
  "text": "Texto da pergunta",
  "options": ["Opcao A", "Opcao B", "Opcao C", "Opcao D"],
  "correctIndex": 1
}
```

`correctIndex` comeca em `0`, por isso `1` significa a segunda opcao.

## Limites desta versao

- O quiz usa perguntas fixas em memoria
- Nao ha autenticacao
- O estado ativo do long polling continua em memoria, por isso um reinicio do servidor interrompe jogos em curso

E uma boa base para depois evoluir para:

- guardar quizzes numa base de dados
- separar vista de host e de jogador
- adicionar reconexao e reentrada por sessao
- trocar long polling por WebSocket no futuro, se quiseres
