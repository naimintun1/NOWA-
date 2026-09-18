const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");

const session = require("express-session");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new DatabaseSync("data/nowa.db");
try {
  db.exec("ALTER TABLE users ADD COLUMN online_status INTEGER DEFAULT 1");
} catch (error) {
  if (!String(error.message).includes("duplicate column")) {
    throw error;
  }
}

try {
  db.exec("ALTER TABLE users ADD COLUMN profile_visibility INTEGER DEFAULT 1");
} catch (error) {
  if (!String(error.message).includes("duplicate column")) {
    throw error;
  }
}


db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  )
`);

app.use(express.json());
app.use(session({
  secret: process.env.NOWA_SESSION_SECRET || "nowa-dev-secret-change-later",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));


app.use(express.static("public"));


app.post("/api/follow", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const followerId = Number(req.body.followerId);
  const followingId = Number(req.body.followingId);

  if (followerId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!followerId || !followingId || followerId === followingId) {
    return res.status(400).json({ error: "Invalid follow data" });
  }

  try {
    db.prepare(`
      INSERT INTO follows (follower_id, following_id)
      VALUES (?, ?)
    `).run(followerId, followingId);

    res.json({ following: true });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.json({ following: true });
    }

    res.status(500).json({ error: "Could not follow user" });
  }
});

app.post("/api/unfollow", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const followerId = Number(req.body.followerId);
  const followingId = Number(req.body.followingId);

  if (!followerId || !followingId) {
    return res.status(400).json({ error: "Invalid follow data" });
  }

  db.prepare(`
    DELETE FROM follows
    WHERE follower_id = ? AND following_id = ?
  `).run(followerId, followingId);

  res.json({ following: false });
});

app.get("/api/follow-status", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const followerId = Number(req.query.followerId);
  const followingId = Number(req.query.followingId);

  if (followerId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!followerId || !followingId) {
    return res.status(400).json({ error: "Invalid user IDs" });
  }

  const iFollow = db.prepare(`
    SELECT id
    FROM follows
    WHERE follower_id = ? AND following_id = ?
  `).get(followerId, followingId);

  const followsMe = db.prepare(`
    SELECT id
    FROM follows
    WHERE follower_id = ? AND following_id = ?
  `).get(followingId, followerId);

  res.json({
    following: !!iFollow,
    followsYou: !!followsMe,
    friend: !!iFollow && !!followsMe
  });
});

app.get("/api/conversations", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const conversations = db.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.profile_photo,
      MAX(m.id) AS last_message_id,
      MAX(m.created_at) AS last_message_time,
      (
        SELECT m2.message
        FROM messages m2
        WHERE
          ((m2.sender_id = ? AND m2.receiver_id = u.id)
          OR
          (m2.sender_id = u.id AND m2.receiver_id = ?))
        ORDER BY m2.id DESC
        LIMIT 1
      ) AS last_message
    FROM messages m
    JOIN users u
      ON u.id = CASE
        WHEN m.sender_id = ? THEN m.receiver_id
        ELSE m.sender_id
      END
    WHERE m.sender_id = ? OR m.receiver_id = ?
    GROUP BY u.id, u.username, u.profile_photo
    ORDER BY last_message_id DESC
    LIMIT 5
  `).all(userId, userId, userId, userId, userId);

  res.json(conversations);
});

app.post("/api/messages/read", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const receiverId = Number(req.body.receiverId);
  const senderId = Number(req.body.senderId);

  if (receiverId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!receiverId || !senderId) {
    return res.status(400).json({ error: "Invalid user IDs" });
  }

  db.prepare(`
    UPDATE messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE sender_id = ?
      AND receiver_id = ?
      AND read_at IS NULL
  `).run(senderId, receiverId);

  res.json({ success: true });
});

app.get("/api/unread-counts", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const counts = db.prepare(`
    SELECT
      sender_id AS user_id,
      COUNT(*) AS unread_count
    FROM messages
    WHERE receiver_id = ?
      AND read_at IS NULL
    GROUP BY sender_id
  `).all(userId);

  res.json(counts);
});

app.get("/api/messages", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const senderId = Number(req.query.senderId);
  const receiverId = Number(req.query.receiverId);

  if (senderId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!senderId || !receiverId) {
    return res.status(400).json({ error: "Invalid user IDs" });
  }

  const messages = db.prepare(`
    SELECT
      id,
      sender_id,
      receiver_id,
      message,
      created_at
    FROM messages
    WHERE
      (sender_id = ? AND receiver_id = ?)
      OR
      (sender_id = ? AND receiver_id = ?)
    ORDER BY id ASC
  `).all(senderId, receiverId, receiverId, senderId);

  res.json(messages);
});

app.post("/api/messages", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const senderId = Number(req.body.senderId);
  const receiverId = Number(req.body.receiverId);
  const message = String(req.body.message || "").trim();

  if (senderId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!senderId || !receiverId || !message) {
    return res.status(400).json({ error: "Missing message data" });
  }

  const result = db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, message)
    VALUES (?, ?, ?)
  `).run(senderId, receiverId, message);

  const saved = db.prepare(`
    SELECT id, sender_id, receiver_id, message, created_at
    FROM messages
    WHERE id = ?
  `).get(result.lastInsertRowid);

  res.json(saved);
});

app.post("/api/profile-photo", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.body.userId);
  const profilePhoto = String(req.body.profilePhoto || "");

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId || !profilePhoto) {
    return res.status(400).json({ error: "Missing profile photo data" });
  }

  db.prepare(`
    UPDATE users
    SET profile_photo = ?
    WHERE id = ?
  `).run(profilePhoto, userId);

  res.json({ success: true });
});




app.get("/api/friends", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const friends = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.profile_photo,
      u.bio
    FROM follows f1
    JOIN follows f2
      ON f2.follower_id = f1.following_id
      AND f2.following_id = f1.follower_id
    JOIN users u
      ON u.id = f1.following_id
    WHERE f1.follower_id = ?
    ORDER BY u.username
    LIMIT 10
  `).all(userId);

  res.json(friends);
});

app.get("/api/friends-count", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const result = db.prepare(`
    SELECT COUNT(*) AS count
    FROM follows f1
    JOIN follows f2
      ON f2.follower_id = f1.following_id
      AND f2.following_id = f1.follower_id
    WHERE f1.follower_id = ?
  `).get(userId);

  res.json({ count: Number(result.count) });
});


app.get("/api/privacy", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const user = db.prepare(`
    SELECT online_status, profile_visibility
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    onlineStatus: Boolean(user.online_status),
    profileVisibility: Boolean(user.profile_visibility)
  });
});

app.post("/api/privacy", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.body.userId);
  const onlineStatus = req.body.onlineStatus ? 1 : 0;
  const profileVisibility = req.body.profileVisibility ? 1 : 0;

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  db.prepare(`
    UPDATE users
    SET online_status = ?,
        profile_visibility = ?
    WHERE id = ?
  `).run(onlineStatus, profileVisibility, userId);

  res.json({
    success: true,
    onlineStatus: Boolean(onlineStatus),
    profileVisibility: Boolean(profileVisibility)
  });
});

app.get("/api/profile", (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const user = db.prepare(`
    SELECT id, username, profile_photo, bio, profile_visibility
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!user.profile_visibility) {
    return res.json({
      id: user.id,
      username: user.username,
      profile_photo: null,
      bio: null,
      profileHidden: true
    });
  }

  res.json(user);
});

app.post("/api/profile", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.body.userId);
  const bio = String(req.body.bio || "").trim().slice(0, 150);

  if (userId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  db.prepare(`
    UPDATE users
    SET bio = ?
    WHERE id = ?
  `).run(bio, userId);

  res.json({ success: true, bio });
});

app.get("/api/profile-photo", (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const user = db.prepare(`
    SELECT profile_photo, profile_visibility
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    profilePhoto:
      user.profile_visibility
        ? (user.profile_photo || null)
        : null
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ success: false });
    }

    res.json({ success: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    userId: req.session.userId,
    username: req.session.username
  });
});

app.get("/api/users", (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.json([]);
  }

  const users = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username LIKE ?
    ORDER BY username
    LIMIT 20
  `).all("%" + q + "%");

  res.json(users);
});


app.post("/api/change-password", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      success: false,
      message: "Not logged in."
    });
  }

  const userId = Number(req.body.userId);
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  if (userId !== req.session.userId) {
    return res.status(403).json({
      success: false,
      message: "Unauthorized."
    });
  }

  if (!userId || !currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "All password fields are required."
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: "New password must be at least 6 characters."
    });
  }

  try {
    const user = db.prepare(`
      SELECT id, password
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const valid = await bcrypt.compare(
      currentPassword,
      user.password
    );

    if (!valid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect."
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    db.prepare(`
      UPDATE users
      SET password = ?
      WHERE id = ?
    `).run(hashedPassword, userId);

    res.json({
      success: true,
      message: "Password changed successfully."
    });

  } catch (error) {
    console.error("Change password error:", error);

    res.status(500).json({
      success: false,
      message: "Server error."
    });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required."
    });
  }

  try {
    const stmt = db.prepare(`
      SELECT id, username, password
      FROM users
      WHERE username = ?
    `);

    const user = stmt.get(username);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password."
      });
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({
      success: true,
      userId: user.id,
      username: user.username,
      message: "Login successful!",
      user: {
        id: user.id,
        username: user.username
      }
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Server error."
    });
  }
});

app.post("/api/signup", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required."
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      success: false,
      message: "Username must be at least 3 characters."
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters."
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (username, password)
      VALUES (?, ?)
    `);

    const result = stmt.run(username, hashedPassword);

    req.session.userId = Number(result.lastInsertRowid);
    req.session.username = username;

    res.json({
      success: true,
      message: "Account created successfully!",
      userId: Number(result.lastInsertRowid),
      username
    });

  } catch (error) {
    if (
      error.code === "ERR_SQLITE_ERROR" &&
      error.errstr &&
      error.errstr.includes("UNIQUE constraint failed: users.username")
    ) {
      return res.status(409).json({
        success: false,
        message: "Username already exists."
      });
    }

    console.error(error);

    res.status(500).json({
      success: false,
      message: "Server error."
    });
  }
});


try {
  db.exec("ALTER TABLE users ADD COLUMN bio TEXT");
} catch (error) {
  if (!String(error.message).includes("duplicate column")) {
    throw error;
  }
}

try {
  db.exec("ALTER TABLE messages ADD COLUMN read_at DATETIME");
} catch (error) {
  if (!String(error.message).includes("duplicate column")) {
    throw error;
  }
}

const onlineUsers = new Map();

app.get("/api/online-users", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const currentUserId = Number(req.query.userId || 0);

  if (currentUserId !== req.session.userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const ids = Array.from(onlineUsers.keys());

  if (!ids.length) {
    return res.json([]);
  }

  const placeholders = ids.map(() => "?").join(",");

  const users = db.prepare(`
    SELECT id, username, profile_photo
    FROM users
    WHERE id IN (${placeholders})
    ORDER BY username
  `).all(...ids);

  res.json(
    users.filter(user => user.id !== currentUserId)
  );
});

app.get("/api/online-status", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const user = db.prepare(`
    SELECT online_status
    FROM users
    WHERE id = ?
  `).get(userId);

  res.json({
    online: Boolean(user && user.online_status) && onlineUsers.has(userId)
  });
});


io.on("connection", (socket) => {
  const userId = Number(socket.handshake.query.userId);

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  if (userId) {
    onlineUsers.set(userId, socket.id);
    io.emit("userOnline", { userId });
  }

  console.log("User connected:", socket.id);

  socket.on("sendMessage", (data) => {
    const senderId = Number(data.senderId);
    const receiverId = Number(data.receiverId);
    const message = String(data.message || "").trim();

    if (!senderId || !receiverId || !message) return;

    if (senderId !== userId) {
      return;
    }

    const result = db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, message)
      VALUES (?, ?, ?)
    `).run(senderId, receiverId, message);

    const saved = db.prepare(`
      SELECT id, sender_id, receiver_id, message, created_at
      FROM messages
      WHERE id = ?
    `).get(result.lastInsertRowid);

    const receiverSocket = onlineUsers.get(receiverId);

    if (receiverSocket) {
      io.to(receiverSocket).emit("newMessage", saved);
    }

    socket.emit("newMessage", saved);
  });

  socket.on("disconnect", () => {
    if (userId && onlineUsers.get(userId) === socket.id) {
      onlineUsers.delete(userId);
      io.emit("userOffline", { userId });
    }

    console.log("User disconnected:", socket.id);
  });
});

const PORT = 3000;

server.listen(PORT, () => {
  console.log(`NOWA server running at http://localhost:${PORT}`);
});
