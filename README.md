# 🎮 Pixel Battle – Multiplayer Computer Graphics Game

**A real-time multiplayer pixel-art game developed as a group project for CSSD 315 Computer Graphics at Ghana Communication Technology University (GCTU).**

Pixel Battle allows players to join competing teams and create artwork together on a shared **128 × 128 pixel canvas** using computer graphics algorithms.

🔗 **Play Live:** https://pixel-battle-wixi.onrender.com

## 🎯 Game Overview

Pixel Battle combines computer graphics concepts with an interactive multiplayer experience. Players can choose between two game modes:

### 1. Normal Battle

Create pixel artwork freely while competing as part of one of four teams.

- Draw using the available graphics tools.
- Work together with teammates on a shared canvas.
- Earn points through team-owned pixels.
- Monitor team scores on the live scoreboard.
- Use undo, redo and eraser features.
- Watch drawing activity through the action history and replay features.

### 2. Build a House Challenge

Apply computer graphics algorithms to construct a house within your team's zone.

- All teams receive the same house-building task.
- Use the available drawing algorithms to create the required house features.
- Choose colours and tools to complete your design.
- Follow the live evaluation scoreboard to monitor your progress.
- Receive a score based on house construction and algorithm usage.

The challenge is evaluated by the server using a deterministic scoring system.

## 🕹️ Teams

The game has four competing teams, each assigned a section of the canvas.

| Team | Canvas Zone |
|---|---|
| 🔴 Red Rockets | Top-left |
| 🔵 Blue Bolts | Top-right |
| 🟢 Green Giants | Bottom-left |
| 🟡 Gold Griffins | Bottom-right |

Each team competes to achieve the highest score.

Team ownership is tracked separately from pixel colour. This means a team's score is based on the pixels it owns, not simply the colours displayed on the canvas.

## 🧮 Computer Graphics Algorithms

Pixel Battle demonstrates important rasterisation and computer graphics algorithms.

| Algorithm | Purpose |
|---|---|
| DDA Line Algorithm | Draws a line by calculating intermediate pixel positions. |
| Bresenham's Line Algorithm | Draws lines efficiently using integer-based calculations. |
| Midpoint Circle Algorithm | Draws circles using symmetry and decision parameters. |
| Scan-Line Polygon Fill | Fills a polygon by processing horizontal scan lines. |
| Flood Fill | Fills a connected region of pixels using a queue-based approach. |

### Frame Buffer

The game uses a pixel-based frame buffer to represent the shared canvas.

- Canvas dimensions: 128 × 128 pixels.
- Total pixels: 16,384.
- Pixel data is stored in a `Uint8Array`.
- Each position stores a palette index.
- Pixel positions are calculated using:

`index = y * width + x`

The frame buffer allows the application to update and display individual pixels.

## 🎨 Colour System

Pixel Battle includes a 16-colour palette based on the HSB colour model.

Players can work with colour values represented in:

- HSB (Hue, Saturation and Brightness)
- RGB (Red, Green and Blue)
- HEX colour notation

Team colours are also available in the palette.

## ⚙️ Key Features

- Real-time multiplayer drawing.
- Shared 128 × 128 pixel canvas.
- Four team-based playing zones.
- Two independent game experiences: Normal Battle and Build a House Challenge.
- Computer graphics drawing algorithms.
- 16-colour palette.
- Server-managed five-second drawing cooldown.
- Team ownership scoring.
- Live scoreboard.
- Undo and redo.
- Eraser tool.
- Action history and time-lapse replay.
- Host controls for managing the game.
- Responsive interface for phones and laptops.
- Server-side evaluation for Build a House Challenge.

## 🏠 Build a House Challenge Scoring

The Build a House Challenge uses a 100-mark evaluation system.

| Assessment Area | Marks |
|---|---:|
| House Construction | 60 |
| Graphics Algorithm Usage | 40 |
| **Total** | **100** |

The house construction assessment checks the required parts of the house, while the algorithm assessment considers the use of the supported drawing algorithms.

The server evaluates the canvas rather than relying on scores submitted by the browser.

## 📋 How to Play

### Normal Battle

1. Open the live game link.
2. Enter your player details.
3. Select a team.
4. Choose a drawing tool and colour.
5. Draw on your team's section of the canvas.
6. Work with your teammates to earn points.
7. Follow the scoreboard to see which team is leading.

### Build a House Challenge

1. Open the game and select Build a House Challenge.
2. Join a team.
3. Study the house-building task.
4. Select the available drawing tools.
5. Construct your house using the graphics algorithms.
6. Check the evaluation scoreboard to monitor your marks.
7. Work towards achieving the highest score.

## 🛠️ Technologies Used

| Technology | Purpose |
|---|---|
| HTML | Application structure |
| CSS | Styling and responsive interface |
| JavaScript | Game logic and frontend interactions |
| Node.js | Backend server |
| WebSockets (`ws`) | Real-time communication |
| HTML Canvas | Rendering the pixel canvas |
| Git and GitHub | Version control and collaboration |
| Render | Online deployment |

## 🏗️ Project Architecture

Pixel Battle follows a client-server architecture.

### Client Side

The browser handles:

- User interaction.
- Tool selection.
- Colour selection.
- Canvas display.
- Sending drawing actions to the server.
- Displaying scores and game updates.

### Server Side

The Node.js server handles:

- WebSocket connections.
- Player and team management.
- Drawing action validation.
- Cooldown enforcement.
- Pixel ownership and scoring.
- Game state management.
- Challenge evaluation.
- Action history and replay data.

The server is responsible for validating drawing actions and maintaining the authoritative game state.

## 🚀 Running the Project Locally

### Prerequisites

Install:

- Node.js version 18 or later.
- npm.
- Git (optional, for cloning the repository).

### 1. Clone the Repository

```bash
git clone https://github.com/Antoinette44/Pixel-Battle-GCTU-2026.git
```

### 2. Enter the Project Folder

```bash
cd Pixel-Battle-GCTU-2026
```

### 3. Install Dependencies

```bash
npm ci
```

### 4. Start the Server

```bash
npm start
```

### 5. Open the Application

Visit:

```text
http://localhost:4000
```

To allow other devices on the same Wi-Fi network to join, use the computer's local network IP address and ensure the server is reachable through the network.

## 🔐 Host and Admin Controls

The application includes host/admin controls for managing game activities.

Administrative access is protected using an admin key configured through the server environment.

Keep the admin key private. Do not publish real secrets or credentials in the repository.

## 🌍 Deployment

Pixel Battle is deployed using Render.

**Live application:** https://pixel-battle-wixi.onrender.com

The project runs as a Node.js web service and uses WebSockets for real-time communication between connected players.

## 🧪 Testing

The project includes automated tests for important game components and behaviours.

Run the main test suite:

```bash
npm test
```

Additional test files include:

```bash
node tests/dda.test.js
node tests/house.test.js
node tests/house-server.test.js
node tests/normal_battle_golden.test.js
```

The tests cover areas such as:

- Rasterisation algorithms.
- Frame buffer and board operations.
- Drawing action validation.
- Team ownership and scoring.
- Cooldown behaviour.
- Reset and challenge behaviour.
- House evaluation.
- Normal Battle behaviour.

## 📁 Project Structure

```text
Pixel-Battle-GCTU-2026/
│
├── public/
│   ├── index.html
│   ├── app.js
│   ├── raster.js
│   └── style.css
│
├── lib/
│   ├── house-config.js
│   └── house-evaluator.js
│
├── tests/
│   ├── dda.test.js
│   ├── house.test.js
│   ├── house-server.test.js
│   ├── normal_battle_golden.test.js
│   └── fixtures/
│       └── normal-battle.golden.json
│
├── server.js
├── package.json
├── package-lock.json
├── render.yaml
└── README.md
```

*Note: This is a simplified overview. The repository may contain additional files.*

## 🎓 Learning Outcomes

Through this project, we explored how theoretical computer graphics concepts can be applied in a practical application.

Key learning areas include:

- Understanding pixel representation and frame buffers.
- Implementing rasterisation algorithms.
- Applying geometric calculations to drawing.
- Understanding client-server communication.
- Using WebSockets for real-time multiplayer interaction.
- Managing shared application state.
- Implementing server-side validation and scoring.
- Testing and deploying a web application.
- Collaborating through Git and GitHub.

## 👥 Project Information

**Course:** CSSD 315 – Computer Graphics  
**Institution:** Ghana Communication Technology University (GCTU)  
**Project:** Pixel Battle  
**Project Type:** Group Project

Developed collaboratively as part of our Computer Graphics coursework.

## 📌 Project Evidence and Documentation

The following evidence supports the project demonstration and coursework documentation:

- Gameplay screenshots.
- Multiplayer demonstration video.
- Normal Battle and Build a House Challenge demonstrations.
- Testing results.
- Weekly project diary.
- Team contribution table.
- AI-use declaration.

## 🙌 Acknowledgements

We appreciate our lecturer and teammates for their guidance, contributions and collaboration throughout the development of Pixel Battle.

The project provided an opportunity to turn computer graphics concepts into an interactive multiplayer experience.

---

**Pixel Battle – Learn Computer Graphics. Create Together. Compete as a Team.**
