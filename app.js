const PON = require("./PON.js")
var express = require('express');
const cookie = require('cookie');
var eloRating = require('elo-rating');
const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
	pingTimeout: 15000,
	pingInterval: 45000,
});
const port = process.env.PORT || 3000;
app.use(express.static('public'));
http.listen(port, () => {
	console.log(`Socket.IO server running at http://localhost:${port}/`);
});
var nodemailer = require('nodemailer');
var transporter = nodemailer.createTransport({
	service: 'gmail',
	auth: {
		user: 'admin@patienceonline.com',
		pass: 'cbaGfed737'
	}
});
var mysql = require('mysql');
var dbHost = "aa1hlguckgfyb7e.cyvubnpo6dpg.eu-central-1.rds.amazonaws.com"
var name = "gregaire"
var dbconnection = mysql.createConnection({
	host: dbHost,
	user: name,
	password: name,
	port: '3306'
});
dbconnection.connect(async function(err) {
	if (err) {
		console.error('Database connection failed: ' + err.stack);
		return;
	}
	console.log('Connected to database.');

	if (!await dbExists(name)) {
		dbconnection.query("CREATE DATABASE IF NOT EXISTS " + name, async function(err, result) {
			console.log("created DB " + name)
			dbconnection.end()
			dbconnection = mysql.createPool({
				connectionLimit: 10,
				host: dbHost,
				user: name,
				password: name,
				port: '3306',
				database: name
			});
			await mysql_insert_users_table()
		})
	} else {
		console.log("DB already exists")
		dbconnection.end()
		dbconnection = mysql.createPool({
			connectionLimit: 10,
			host: dbHost,
			user: name,
			password: name,
			port: '3306',
			database: name
		});

		dbconnection.on('connection', function(connection) {
			connection.query('SET SESSION group_concat_max_len = 100000')
		});
		//dbconnection.query("TRUNCATE games")
		mysql_insert_games_table()
		leaderboard_update()
	}
	async function leaderboard_update() {
		leaderboard = await mysql_select_user_leaderboard()
		if (!leaderboard)
			leaderboard = [{}]
		setTimeout(async function() {
			leaderboard_update()
			io.emit("server_update_leaderboard", leaderboard)
		}, 15 * 60 * 1000)
	}
});

function dbExists(name) {
	return new Promise((resolve) => {
		dbconnection.query("SHOW DATABASES LIKE '" + name + "';",
			function(err, result) {
				resolve(result.length);
			})
	})
}
var ranked_queue = []
var pending_rooms = []
var active_rooms = []
var loggedin_users = []
var link_password_reset_users = []
var leaderboard

io.on('connection', async function(socket) {
	var cookies = cookie.parse(socket.handshake.headers.cookie ? socket.handshake.headers.cookie : "")
	var loggedin_user = loggedin_users.find(user => user.username === cookies.username && user.password === cookies.password)
	login(socket, cookies, loggedin_user)

	socket.on("client_request_history", async function() {
		if (loggedin_user)
			io.to(socket.id).emit("server_update_history", await mysql_select_userhistory(loggedin_user.userid)) //todo store history on server and select just once on log in
	})

	socket.on("disconnect", () => {
		var index_pending = pending_rooms.findIndex(room => room.red_user ? room.red_user.current_socketid === socket.id : room.black_user.current_socketid === socket.id )
		var loggedin_user = loggedin_users.find(user => user.current_socketid === socket.id)
		var index_queue = ranked_queue.findIndex(q => q.socketid === socket.id)
		var spectator_room_index = active_rooms.findIndex(r => r.spectators.find(rs => rs.socketid === socket.id))
		if (spectator_room_index > -1) {
			active_rooms[spectator_room_index].spectators.splice(active_rooms[spectator_room_index].spectators.findIndex(s => s.socketid === socket.id), 1)
		}
		if (index_pending > -1) {
			pending_rooms.splice(index_pending, 1)
			update_pending_rooms_on_clients()
		}
		if (index_queue > -1)
			ranked_queue.splice(index_queue, 1)
		if (loggedin_user)
			loggedin_user.current_socketid = ""
	})

	socket.on("client_newroom", function(data) { // need to send cookie as data because "socket.handshake.headers.cookie" doesn't update the change once the player entered the page
		var cookies = cookie.parse(data.cookie ? data.cookie : "")
		if (!cookies) return
		//validate other settings
		if (!data.roomdata.name) return
		if (data.roomdata.name.length > 30) return
		if (data.roomdata.secret.length > 30) return
		if (!Number.isInteger(data.roomdata.malus_size)) return
		if (!Number.isInteger(data.roomdata.tableau_size)) return
		if (active_rooms.find(room => room.red_user.initial_socketid === cookies.active_game || room.black_user.initial_socketid === cookies.active_game)) return //cant create new room if already active game in different tab --- became redundant through other functionality
		console.log("lobby created")
		var index = pending_rooms.findIndex(room => room.red_user ? room.red_user.current_socketid === socket.id : room.black_user.current_socketid === socket.id )
		if (pending_rooms.find(room => room.red_user ? room.red_user.socketid_cookie_on_reation === cookies.active_game : room.black_user.socketid_cookie_on_reation === cookies.active_game)) {
			pending_rooms.splice(pending_rooms.findIndex(room =>  room.red_user ? room.red_user.socketid_cookie_on_reation === cookies.active_game  : room.black_user.socketid_cookie_on_reation === cookies.active_game), 1) //replace room if another tab in the same browser recreates room
		}
		if (index > -1) {
			pending_rooms.splice(index, 1) //replace room if same tab recreates room
		}
		var room = {
			spectators: [],
			actions: PON.actions_from_PON(data.roomdata.initial_game_pon.substring(data.roomdata.initial_game_pon.indexOf("}") + 1, data.roomdata.initial_game_pon.indexOf("=") != -1 ? data.roomdata.initial_game_pon.indexOf("=") : data.roomdata.initial_game_pon.length)),
			settings: data.roomdata,
			[data.color+"_user"]: {
				current_socketid: socket.id,
				initial_socketid: socket.id,
				socketid_cookie_on_reation: cookies.socketid,
				username: loggedin_user ? loggedin_user.username : "",
				elo: loggedin_user ? loggedin_user.elo : ""
			}
		}
		room.settings.initial_game_pon = data.roomdata.initial_game_pon.substring(0, data.roomdata.initial_game_pon.indexOf("}") + 1)
		pending_rooms.push(room)
		update_pending_rooms_on_clients()
		return
	})

	socket.on("client_join", (data) => {
		var cookies = cookie.parse(data.cookie ? data.cookie : "")
		if (!cookies) return
		var index = pending_rooms.findIndex(room =>room.red_user ?  room.red_user.initial_socketid === data.socketid : room.black_user.initial_socketid === data.socketid)
		var active_room_joiner = active_rooms.find(room => room.red_user.initial_socketid === cookies.active_game || room.black_user.initial_socketid === cookies.active_game)
		if (index < 0) return //check whether room socket is trying to join exist
		if (pending_rooms[index].red_user ? pending_rooms[index].red_user.initial_socketid === socket.id : pending_rooms[index].black_user.initial_socketid === socket.id ) return //cant join your own room
		if (active_room_joiner != undefined) return //cant join if already in an active game in different tab
		if (pending_rooms[index].settings.secret.length != 0 && pending_rooms[index].settings.secret != data.secret) return //secret check
		if (pending_rooms[index].red_user ? pending_rooms[index].red_user.socketid_cookie_on_reation === cookies.socketid : pending_rooms[index].black_user.socketid_cookie_on_reation === cookies.socketid) return //cant join if socket is trying to join a room that was created in a different tab/same browser
		pending_rooms[index].game = PON.game_from_PON(pending_rooms[index].settings.game_pon)
		pending_rooms[index][(pending_rooms[index].red_user ? "black" : "red") +"_user"] = {
			current_socketid: socket.id,
			initial_socketid: socket.id,
			username: loggedin_user ? loggedin_user.username : "",
			elo: loggedin_user ? loggedin_user.elo : ""
		}
		start_active_room(pending_rooms[index])
		update_activerooms_onclients()
	})

	socket.on("ranked_queue", (data) => {  
		var cookies = cookie.parse(data.cookie ? data.cookie : "")
		if (!loggedin_user) return
		if (active_rooms.find(r => r.red_user.username === loggedin_user.username || r.black_user.username === loggedin_user.username)) return
		if (ranked_queue.find(q => q.username === loggedin_user.username)) return
		if (!cookies) return
		if (ranked_queue.length != 0) {
			if (ranked_queue.find(q => q.elo > loggedin_user.elo - 300 && q.elo < loggedin_user.elo + 300)) {
				var black = ranked_queue.find(q => q.elo > loggedin_user.elo - 300 && q.elo < loggedin_user.elo + 300)
				var room = {
					spectators: [],
					actions: [],
					settings: {
						name: loggedin_user.username + " vs. " + black.username,
						secret: "",
						mode: "ranked",
						time: 1800,
						increment: 0,
						moves_counter: 5,
						malus_size: 16,
						tableau_size: 5,
					},
					red_user: {
						current_socketid: socket.id,
						initial_socketid: socket.id,
						username: loggedin_user.username,
						elo: loggedin_user.elo,
					},
					black_user: {
						current_socketid: black.socketid,
						initial_socketid: black.socketid,
						username: black.username,
						elo: black.elo,
					}
				}
				room.game = game_from_settings(room.settings)
				room.settings.initial_game_pon = PON.PON_from_game(room.game)
				start_active_room(room)
				update_activerooms_onclients()
				return
			}
		}
		ranked_queue.push({
			socketid: socket.id,
			elo: loggedin_user.elo,
			username: loggedin_user.username
		})
		io.to(socket.id).emit("queued_up")
	})

	socket.on("game_chat_message", data => {
		var room = active_rooms.find(room => room.red_user.current_socketid === socket.id || room.black_user.current_socketid === socket.id)
		if (room.settings.mode === "unranked" || room.settings.mode === "ranked")
			io.to(socket.id === room.red_user.current_socketid ? room.black_user.current_socketid : room.red_user.current_socketid).emit("chat_update", data)
	})

	socket.on("game_action", (from, to) => {
		if (!from || !to) return
		var room = active_rooms.find(room => room.red_user.current_socketid === socket.id || room.black_user.current_socketid === socket.id)
		if (!room) return
		var socket_color = room.red_user.current_socketid === socket.id ? "red" : "black"
		var turn_color = room.game.turn
		var opponent_color = turn_color === 'black' ? 'red' : 'black'
		if(socket_color!= turn_color) return
		if (!(from.includes("tableau") || from.includes("foundation") || from === turn_color + "malus" || from === turn_color + "reserve" || from === turn_color + "stock")) return
		if (from.includes("foundation") && (to === opponent_color + "malus" || to === opponent_color + "discard")) return
		if (room.game[from].length > 0 && !room.game[from][room.game[from].length - 1].faceup) return
		if (!(to.includes("tableau") || to.includes("foundation") || to.includes("malus") || to === opponent_color + "discard" || to === turn_color + "reserve" || to === turn_color + "discard")) return
		if (to.includes("reserve") && room.game[to].length != 0) return
		if (to === turn_color + "discard" && from === turn_color + "malus") return
		if (room.turn_counter === 0 && (to === opponent_color + "malus" || to === opponent_color + "discard")) return
		if (room.turn_counter === 0 && (from === socket_color + "malus")) return
		var from_uppermost_card = room.game[from][room.game[from].length - 1]
		if (!from_uppermost_card) {
			return
		}
		var to_uppermost_card = room.game[to][room.game[to].length - 1]
		if (to.includes("foundation")) {
			if (to_uppermost_card != undefined) {
				if (to_uppermost_card.value != from_uppermost_card.value - 1)
					return
				if (to_uppermost_card.suit != from_uppermost_card.suit)
					return
			} else {
				if (from_uppermost_card.value != 1) return
			}
		}
		if (to.includes("tableau") && to_uppermost_card != undefined) {
			if (to_uppermost_card.value != from_uppermost_card.value + 1)
				return
			if (to_uppermost_card.suit === "spades" || to_uppermost_card.suit === "clubs")
				if (!(from_uppermost_card.suit === "hearts" || from_uppermost_card.suit === "diamonds"))
					return
			if (to_uppermost_card.suit === "hearts" || to_uppermost_card.suit === "diamonds")
				if (!(from_uppermost_card.suit === "spades" || from_uppermost_card.suit === "clubs"))
					return
		}
		if ((to.includes("malus") || to === opponent_color + "discard")) {
			if (to_uppermost_card != undefined) {
				if (!(to_uppermost_card.value === from_uppermost_card.value || to_uppermost_card.value === from_uppermost_card.value + 1 || to_uppermost_card.value === from_uppermost_card.value - 1 || (to_uppermost_card.value === 13 && from_uppermost_card.value === 1) || (to_uppermost_card.value === 1 && from_uppermost_card.value === 13)))
					return
				if (!((to_uppermost_card.value != from_uppermost_card.value & to_uppermost_card.suit === from_uppermost_card.suit) || (to_uppermost_card.value === from_uppermost_card.value & to_uppermost_card.suit != from_uppermost_card.suit)))
					return
			}
		}
		apply_move_to_active_room(room, socket.id, from, to)
	})

	socket.on("leave_queue", () => {
		var index_queue = ranked_queue.findIndex(q => q.socketid === socket.id)
		if (index_queue > -1)
			ranked_queue.splice(index_queue, 1)
	})

	socket.on("client_surrender", () => {
		var room = active_rooms.find(room => room.red_user.current_socketid === socket.id || room.black_user.current_socketid === socket.id)
		if (!room) return
		var winner = {
			winner: socket.id === room.red_user.current_socketid ? 'black' : 'red',
			event: "surrender"
		}
		var index = active_rooms.findIndex(room => room.red_user.current_socketid === socket.id || room.black_user.current_socketid === socket.id)
		end_game(index, winner)
	})

	socket.on("client_create_account", async function(data) {
		console.log("requesting acc creation")
		if (data.username.length < 5 || data.username.length > 20 || !(/^[A-Za-z0-9]+$/.test(data.username))) return
		if (data.username === "guest" || data.username === "black" || data.username === "ranked" || data.username === "color" || data.username === "unranked" || data.username === "admin" || data.username === "patience" || data.username === "solitaire" || data.username === "patienceonline") return
		if (data.password.length != 64 || !(/^[A-Za-z0-9]+$/.test(data.password))) return
		if (data.email.length < 8 || data.email.length > 50 || !(/^[\w._-]+[+]?[\w._-]+@[\w.-]+\.[a-zA-Z]{2,6}$/.test(data.email))) return
		var user = await mysql_insert_newuser(data.username, data.password, data.email)
		if (user.username)
			loggedin_users.push(user)
		io.to(socket.id).emit("server_account_response", user)
	})

	socket.on("client_login_account", async function(data) {
		if (data.username.length < 5 || data.username.length > 20 || !(/^[A-Za-z0-9]+$/.test(data.username))) return
		if (data.password.length != 64 || !(/^[A-Za-z0-9]+$/.test(data.password))) return
		var db_res = await mysql_select_user_usernamepassword(data.username, data.password)
		if (db_res.username) {
			if (!loggedin_users.find(user => user.username === db_res.username))
				loggedin_users.push(db_res)
		}
		io.to(socket.id).emit("server_login_response", db_res)
	})

	socket.on("link_change_password", (data) => {
		var index = link_password_reset_users.findIndex(u => u.socketid === socket.id)
		var loggedinuser_index = loggedin_users.findIndex(u => u.username === link_password_reset_users[index].username)
		if (index === -1) return
		if (link_password_reset_users[index].socketid != socket.id) return
		if (data.password.length != 64) return

		if (loggedinuser_index != -1)
			loggedin_users.splice(loggedinuser_index, 1)
		mysql_update_userpw(link_password_reset_users[index].userid, data.password)
		clearTimeout(link_password_reset_users[index].timeout)
		link_password_reset_users.splice(index, 1)
		io.to(socket.id).emit("link_change_password_response")
	})

	socket.on("account_change_password", data => {
		if (!loggedin_user) return
		if (data.current_password.length != 64) return
		if (data.new_password.length != 64) return
		if (data.current_password != loggedin_user.password) return
		mysql_update_userpw(loggedin_user.userid, data.new_password)
		loggedin_users.splice(loggedin_users.findIndex(u => u.username === loggedin_user.username), 1)
		io.to(socket.id).emit("account_change_password_response")
	})

	socket.on("client_forgot_password", async function(data) {
		var dbres = await mysql_select_user_email(data.email)
		if (dbres.email != undefined) {
			var reset_token = shuffle(socket.id.split("")).join("") + shuffle(socket.id.split("")).join("")
			dbres.reset_token = reset_token
			dbres.timeout = setTimeout((user) => {
				link_password_reset_users.splice(link_password_reset_users.findIndex(u => u.username === user.username), 1)
			}, 1000 * 60 * 60) //1sec*60 = 1min*60 = 1h
			link_password_reset_users.push(dbres)
			var mailOptions = {
				from: 'admin@patienceonline.com',
				to: dbres.email,
				subject: 'Patience Online password reset request',
				text: 'https://patienceonline.com?' + reset_token
			};
			transporter.sendMail(mailOptions, function(error, info) {
				if (error) {
					console.log(error);
				} else {
					console.log('Email sent: ' + info.response);
				}
			});
		}
		io.to(socket.id).emit("forgot_password_response", dbres.email != undefined)
	})

	socket.on("spectate_game", function(data) {
		var room = active_rooms.find(r => r.black_user.initial_socketid === data.initial_black_socketid && r.red_user.initial_socketid === data.initial_red_socketid)
		if (room) {
			room.spectators.push({
				socketid: socket.id,
				initial_black_socketid: data.initial_black_socketid,
				initial_red_socketid: data.initial_red_socketid
			})
			io.to(socket.id).emit("start_game", {
				game_PON: PON.PON_from_game(room.game, true),
				color: "red",
				red: room.red_user,
				black: room.black_user,
				spectator: true,
				actions_PON: "",
				last_action: room.last_action
			})
		}
	})

	socket.on("spectator_leave", function(data) {
		var spectator_room_index = active_rooms.findIndex(r => r.spectators.find(rs => rs.socketid === socket.id))
		if (active_rooms[spectator_room_index]) {
			active_rooms[spectator_room_index].spectators.splice(active_rooms[spectator_room_index].spectators.findIndex(s => s.socketid === socket.id), 1)
		}
	})

})

function start_active_room(room) {
	if (room.red_user && room.red_user.socketid_cookie_on_reation)
		delete room.red_user.socketid_cookie_on_reation
	else 
		if(room.black_user && room.black_user.socketid_cookie_on_reation)
			delete room.black_user.socketid_cookie_on_reation
	qindex1 = ranked_queue.findIndex(q => q.socketid === room.red_user.current_socketid)
	if (qindex1 > -1)
		ranked_queue.splice(qindex1, 1)
	qindex2 = ranked_queue.findIndex(q => q.socketid === room.black_user.current_socketid)
	if (qindex2 > -1)
		ranked_queue.splice(qindex2, 1)
	pendingindex1 = pending_rooms.findIndex(p => p.red_user.initial_socketid === room.red_user.initial_socketid)
	if (pendingindex1 > -1)
		pending_rooms.splice(pendingindex1, 1)
	pendingindex2 = pending_rooms.findIndex(p => p.red_user.initial_socketid === room.black_user.initial_socketid)
	if (pendingindex2 > -1)
		pending_rooms.splice(pendingindex2, 1)
	var time = new Date()
	room.turn_started = time
	room.game_started = time
	room.last_action = time
	room.disconnect = setTimeout((room) => {
		if (room) {
			if(room.game[room.game.turn+"stock"].length > 0)
				apply_move_to_active_room(room, room[room.game.turn + "_user"].current_socketid, room.game.turn + "stock", room.game.turn + "discard")
		}
	}, room.game.turn === "red" ? room.game.timer_red * 1000 : room.game.timer_black * 1000, room)
	active_rooms.push(room)
	update_pending_rooms_on_clients()
	io.to(room.red_user.current_socketid).emit("start_game", {
		color: "red",
		game_PON: room.settings.initial_game_pon+ PON.PON_from_actions(room.actions),
		red: room.red_user,
		black: room.black_user,
		actions_PON: "",
		last_action: room.last_action
	})
	io.to(room.black_user.current_socketid).emit("start_game", {
		color: "black",
		game_PON:  room.settings.initial_game_pon+ PON.PON_from_actions(room.actions),
		red: room.red_user,
		black: room.black_user,
		actions_PON: "",
		last_action: room.last_action
	})

}

function apply_move_to_active_room(room, socketid, from, to) {
	var index = active_rooms.findIndex(r => r.red_user.current_socketid === room.red_user.current_socketid || r.black_user.current_socketid === room.black_user.current_socketid)
	var turn_color = room.game.turn
	var opponent_color = turn_color === 'black' ? 'red' : 'black'
	var winner
	var time = new Date()
	room.game[to].push(room.game[from].pop())
	if (!to.includes("foundation") && !from.includes("stock"))
		room.game.moves_counter = room.game.moves_counter - 1
	if (room.game[from].length > 0) {
		if (!from.includes("stock"))
			room.game[from][room.game[from].length - 1].faceup = true
	} else if (from.includes("stock")) {
		if (room.game[turn_color + "discard"].length > 0 && to != turn_color + "discard") {
			room.game[turn_color + "discard"].reverse()
			room.game[turn_color + "stock"] = room.game[turn_color + "discard"]
			room.game[turn_color + "discard"] = []
		}
	}

	if (from === turn_color + "malus") {
		if (!room.game[turn_color + "malus"].length && !room.game[turn_color + "reserve"].length) {
			winner = {
				winner: turn_color,
				event: "malus"
			}
		}
		if (room.game[turn_color + "malus"].length < room.game["lowest_malus_" + turn_color]) {
			room.game["lowest_malus_" + turn_color] = room.game["lowest_malus_" + turn_color] - 1
		}
	}
	if (from === turn_color + "reserve") {
		if (!room.game[turn_color + "malus"].length && !room.game[turn_color + "reserve"].length) {
			winner = {
				winner: turn_color,
				event: "malus"
			}
		}
	}
	if (to === turn_color + "discard") {
		if (room.game[opponent_color + "stock"].length === 0) {
			room.game[opponent_color + "discard"].reverse()
			room.game[opponent_color + "stock"] = room.game[opponent_color + "discard"]
			room.game[opponent_color + "discard"] = []
		}
		room.game.moves_counter = room.settings.moves_counter
		room.game.turn = room.game.turn === "red" ? "black" : "red"
		room.game.turn_counter++

		room.game["timer_" + turn_color] = Number(room.game["timer_" + turn_color]) - Number(((time - room.turn_started) / 1000))
		room.game["timer_" + turn_color] = Number(room.game["timer_" + turn_color] )+ Number(room.settings.increment)
		
		clearTimeout(room.disconnect)
		room.disconnect = setTimeout((room) => {
			if (room) {
				var index = active_rooms.findIndex(r => r.red_user.current_socketid === room.red_user.current_socketid && r.black_user.current_socketid === room.black_user.current_socketid)
				end_game(index, {
					winner: room.game.turn === "red" ? "black" : "red",
					event: "timer",

				})
			}
		}, room.game.turn === "red" ? room.game.timer_red * 1000 : room.game.timer_black * 1000, room) //*1000 because ms
		room.turn_started = time
	}
	if (room.game[from].length > 0)
		from_uppermost_card = room.game[from][room.game[from].length - 1]
	else from_uppermost_card = false
	var a = PON.PON_from_action({
		from_stack: from,
		to_stack: to
	})

	var p = PON.action_PON(a, room.game.timer_red.toFixed(3), room.game.timer_black.toFixed(3))
	room.actions.push(p)
	room.last_action = new Date()
	if (room.settings.mode === "unranked" || room.settings.mode === "ranked") {
		io.to(room.red_user.current_socketid).emit("game_update", a)
		io.to(room.black_user.current_socketid).emit("game_update", a)
	} else {
		io.to(socketid).emit("game_update", a)
	}
	if (winner) {
		end_game(index, winner)
	}
	for (var s of room.spectators) {
		if (s.initial_black_socketid === room.black_user.initial_socketid && s.initial_red_socketid === room.red_user.initial_socketid) {
			io.to(s.socketid).emit("game_update", a)
		}
	}
	if (room.game.moves_counter === 0 && room.game[room.game.turn + "stock"].length > 0) {
		apply_move_to_active_room(room, room[room.game.turn + "_user"].current_socketid, room.game.turn + "stock", room.game.turn + "discard")
	}

}

function login(socket, cookies, loggedin_user) {
	if (loggedin_user) {
		disconnect_socket(loggedin_user.current_socketid)
		loggedin_user.current_socketid = socket.id
	}
	disconnect_socket(cookies.socketid)
	if (socket.handshake.headers.referer ? socket.handshake.headers.referer.includes(".com/?") : false) {
		var socketurlparameter = socket.handshake.headers.referer
		socketurlparameter = socketurlparameter.split("")
		socketurlparameter.splice(0, socket.handshake.headers.referer.indexOf(".com/?") + 6)
		socketurlparameter = socketurlparameter.join("")
		var index = link_password_reset_users.findIndex(u => u.reset_token === socketurlparameter)
		if (index != -1) {
			link_password_reset_users[index].socketid = socket.id
			io.to(socket.id).emit("user_login", {
				content: "link_change_password",
				user : false,
				pending_rooms: [],
				leaderboard: leaderboard,
				color: "",
				game: {},
			})
			return
		}
	}
	var active_room1 = loggedin_user ? active_rooms.find(room => room.red_user.username === loggedin_user.username || room.black_user.username === loggedin_user.username) : undefined
	var active_room2 = active_rooms.find(room => room.red_user.initial_socketid === cookies.active_game || room.black_user.initial_socketid === cookies.active_game)
	var room = active_room1 ? active_room1 : active_room2 ? active_room2 : undefined
	if (room) {
		var socket_color = loggedin_user ? loggedin_user.username === room.red_user.username ? "red" : "black" : (cookies.active_game === room.red_user.initial_socketid ? "red" : "black")
		room[socket_color + "_user"].current_socketid = socket.id
		io.to(socket.id).emit(loggedin_user ? "user_login" : "guest_login", {
			content: "game",
			user : loggedin_user ? loggedin_user : false,
			pending_rooms: pending_rooms_client(),
			active_rooms: active_rooms_client(),
			leaderboard: leaderboard,
			game_PON: room.settings.initial_game_pon + PON.PON_from_actions(room.actions),
			red: room.red_user,
			black: room.black_user,
			color: socket_color,
			timer_red: room.game.timer_red - (room.game.turn === "red" ? ((new Date() - room.turn_started) / 1000) :  0),
			timer_black: room.game.timer_black - (room.game.turn === "black" ? ((new Date() - room.turn_started) / 1000) : 0),
			last_action: room.last_action
		})
	} else
		io.to(socket.id).emit(loggedin_user ? "user_login" : "guest_login", {
			content: "casual",
			user : loggedin_user ? loggedin_user : false,
			/*
			user : {
				userid : -1,
				username : "testtest",
				password : "password",
				email : "testmail@test.at",
				wins : 69,
				losses : 10,
				draws : 0,
				elo : 4200,
				created : new Date()
			},
			*/
			pending_rooms: pending_rooms_client(),
			active_rooms: active_rooms_client(),
			leaderboard: leaderboard,
		})
}

function disconnect_socket(socketid) {
	if (socketid != undefined)
		if (io.sockets.sockets.get(socketid))
			io.sockets.sockets.get(socketid).disconnect(true)
}

function game_from_settings(settings) {
	var game = {
		redmalus: [],
		redstock: [],
		reddiscard: [],
		redreserve: [],
		redtableau0: [],
		redtableau1: [],
		redtableau2: [],
		redtableau3: [],
		redfoundation0: [],
		redfoundation1: [],
		redfoundation2: [],
		redfoundation3: [],
		blackmalus: [],
		blackstock: [],
		blackdiscard: [],
		blackreserve: [],
		blacktableau0: [],
		blacktableau1: [],
		blacktableau2: [],
		blacktableau3: [],
		blackfoundation0: [],
		blackfoundation1: [],
		blackfoundation2: [],
		blackfoundation3: [],
		moves_counter: settings.moves_counter,
		lowest_malus_red: settings.malus_size,
		lowest_malus_black: settings.malus_size,
		increment: settings.increment,
		timer_red: settings.time,
		timer_black: settings.time,
		turn_counter: 0,
	}
	var reddeck = shuffle(freshDeck("red"))
	for (var ms = 0; ms < settings.malus_size; ms++) {
		while (reddeck[reddeck.length - 1].value === 13 || reddeck[reddeck.length - 1].value === 1 || (ms < parseInt(settings.malus_size/2) && reddeck[reddeck.length - 1].value < 5)) {
			reddeck = shuffle(reddeck)
		}
		var card = reddeck.pop()
		game.redmalus.push(card)
		game.blackmalus.push(new Card("black", card.suit, card.value))
	}
	game.turn = shuffle(["red", "black"])[0]

	if(settings.tableau_size > 0) {
		var check = false
		do {
			for (var tableau_nr = 0; tableau_nr < 4; tableau_nr++)
				for (var ts = 0; ts < settings.tableau_size; ts++) {
					var card = reddeck.pop()
					game["redtableau" + tableau_nr].push(card)
					game["blacktableau" + tableau_nr].push(new Card("black", card.suit, card.value))
				}
				var counter = 0
				for(var i = 0; i < 4; i++)  {
					if(game["redtableau"+i][game["redtableau"+i].length-1].value === game.redmalus[game.redmalus.length-1].value)
						counter++
					if( game["redtableau"+i][game["redtableau"+i].length-1].value-1 === game.redmalus[game.redmalus.length-1].value || game["redtableau"+i][game["redtableau"+i].length-1].value+1 === game.redmalus[game.redmalus.length-1].value) {
						if(game["redtableau"+i][game["redtableau"+i].length-1].suit === game.redmalus[game.redmalus.length-1].suit)
							counter++
					}
					if( game["redtableau"+i][game["redtableau"+i].length-1].value-1 === game.redmalus[game.redmalus.length-1].value) {
						if(game["redtableau"+i][game["redtableau"+i].length-1].suit === "hearts" || game["redtableau"+i][game["redtableau"+i].length-1].suit === "diamonds")
							if(game.redmalus[game.redmalus.length-1].suit === "clubs" || game.redmalus[game.redmalus.length-1].suit === "spades")
								counter++
						if(game["redtableau"+i][game["redtableau"+i].length-1].suit === "clubs" || game["redtableau"+i][game["redtableau"+i].length-1].suit === "spades")
							if(game.redmalus[game.redmalus.length-1].suit === "hearts" || game.redmalus[game.redmalus.length-1].suit === "diamonds")
								counter++
					}
					if(game["redtableau"+i][game["redtableau"+i].length-1].value === 1)
						counter++
				}	
				if(settings.tableau_size > 1)
					for(var i = 0; i < 4; i++)  {
						if(game["redtableau"+i][game["redtableau"+i].length-2].value === game.redmalus[game.redmalus.length-1].value)
							counter++
						if( game["redtableau"+i][game["redtableau"+i].length-2].value-1 === game.redmalus[game.redmalus.length-1].value || game["redtableau"+i][game["redtableau"+i].length-2].value+1 === game.redmalus[game.redmalus.length-1].value) {
							if(game["redtableau"+i][game["redtableau"+i].length-2].suit === game.redmalus[game.redmalus.length-1].suit)
								counter++
						}
						if( game["redtableau"+i][game["redtableau"+i].length-2].value-1 === game.redmalus[game.redmalus.length-1].value) {
							if(game["redtableau"+i][game["redtableau"+i].length-2].suit === "hearts" || game["redtableau"+i][game["redtableau"+i].length-2].suit === "diamonds")
								if(game.redmalus[game.redmalus.length-1].suit === "clubs" || game.redmalus[game.redmalus.length-1].suit === "spades")
									counter++
							if(game["redtableau"+i][game["redtableau"+i].length-2].suit === "clubs" || game["redtableau"+i][game["redtableau"+i].length-2].suit === "spades")
								if(game.redmalus[game.redmalus.length-1].suit === "hearts" || game.redmalus[game.redmalus.length-1].suit === "diamonds")
									counter++
						}
						if(game["redtableau"+i][game["redtableau"+i].length-2].value === 1)
							counter++
					}	
				if(settings.tableau_size > 2)
					for(var i = 0; i < 4; i++)  {
						if(game["redtableau"+i][game["redtableau"+i].length-3].value === game.redmalus[game.redmalus.length-1].value)
							counter++
						if( game["redtableau"+i][game["redtableau"+i].length-3].value-1 === game.redmalus[game.redmalus.length-1].value || game["redtableau"+i][game["redtableau"+i].length-3].value+1 === game.redmalus[game.redmalus.length-1].value) {
							if(game["redtableau"+i][game["redtableau"+i].length-3].suit === game.redmalus[game.redmalus.length-1].suit)
								counter++
						}
						if( game["redtableau"+i][game["redtableau"+i].length-3].value-1 === game.redmalus[game.redmalus.length-1].value) {
							if(game["redtableau"+i][game["redtableau"+i].length-3].suit === "hearts" || game["redtableau"+i][game["redtableau"+i].length-3].suit === "diamonds")
								if(game.redmalus[game.redmalus.length-1].suit === "clubs" || game.redmalus[game.redmalus.length-1].suit === "spades")
									counter++
							if(game["redtableau"+i][game["redtableau"+i].length-3].suit === "clubs" || game["redtableau"+i][game["redtableau"+i].length-3].suit === "spades")
								if(game.redmalus[game.redmalus.length-1].suit === "hearts" || game.redmalus[game.redmalus.length-1].suit === "diamonds")
									counter++
						}
					}	
				if(counter === 0) {
					check = true
				}
				if(check && reddeck.length > 0)   {
					counter = 0
					if(reddeck[reddeck.length-1].value === game.redmalus[game.redmalus.length-1].value)
						counter++
					if( reddeck[reddeck.length-1].value-1 === game.redmalus[game.redmalus.length-1].value || reddeck[reddeck.length-1].value+1 === game.redmalus[game.redmalus.length-1].value) 
						if(reddeck[reddeck.length-1].suit === game.redmalus[game.redmalus.length-1].suit)
							counter++
					if(reddeck[reddeck.length-1].value === 1)
						counter++
		
					if(reddeck.length > 1) {
						if(reddeck[reddeck.length-2].value === game.redmalus[game.redmalus.length-1].value)
							counter++
						if( reddeck[reddeck.length-2].value-1 === game.redmalus[game.redmalus.length-1].value || reddeck[reddeck.length-2].value+1 === game.redmalus[game.redmalus.length-1].value) 
							if(reddeck[reddeck.length-2].suit === game.redmalus[game.redmalus.length-1].suit)
								counter++
						if(reddeck.length > 2) {
							if(reddeck[reddeck.length-3].value === game.redmalus[game.redmalus.length-1].value)
								counter++
							if( reddeck[reddeck.length-3].value-1 === game.redmalus[game.redmalus.length-1].value || reddeck[reddeck.length-3].value+1 === game.redmalus[game.redmalus.length-1].value) 
								if(reddeck[reddeck.length-3].suit === game.redmalus[game.redmalus.length-1].suit)
									counter++
						}
					}
					if(counter != 0) {
						check = false
					}
				}
				if(!check) {
					for(var p = 0; p < 2; p++)
						for(var i = 0; i < 4; i++)  
							for(var j = 0; j < settings.tableau_size; j++) {
								if(p === 0)
									reddeck.push(game["red" + "tableau"+i].pop())
								if(p === 1)
									game["black" + "tableau"+i].pop()
							}
					reddeck = shuffle(reddeck)
				}
		} while (!check)
	}
	game.redstock = reddeck
	for (var c of reddeck)
		game.blackstock.push(new Card("black", c.suit, c.value))
	return game
}

function update_pending_rooms_on_clients(socketid) {
	if (!socketid)
		io.emit("server_update_pendingrooms", {
			pending_rooms: pending_rooms_client()
		})
	else
		io.to(socketid).emit("server_update_pendingrooms", {
			pending_rooms: pending_rooms_client()
		})
}

function update_activerooms_onclients(socketid) {
	if (!socketid)
		io.emit("server_update_activerooms", {
			active_rooms: active_rooms_client()
		})
	else
		io.to(socketid).emit("server_update_activerooms", {
			active_rooms: active_rooms_client()
		})
}

async function end_game(index, outcome) {
	if (active_rooms[index] === undefined) return
	clearTimeout(active_rooms[index].disconnect)
	var reduser = loggedin_users.find(l => l.username === active_rooms[index].red_user.username)
	var blackuser = loggedin_users.find(l => l.username === active_rooms[index].black_user.username)
	if (active_rooms[index].settings.mode === "ranked") {
		if (reduser && blackuser) {
			var elochange
			if ( outcome.winner === "red" ) {
				elochange = eloRating.calculate(reduser.elo, blackuser.elo, true, 20)
				reduser.elo = elochange.playerRating
				blackuser.elo = elochange.opponentRating
				reduser.wins = reduser.wins+1
				blackuser.losses = blackuser.losses+1
			}
			if ( outcome.winner === "black" ) {
				elochange = eloRating.calculate(blackuser.elo, reduser.elo, true, 20)
				blackuser.elo = elochange.playerRating
				reduser.elo = elochange.opponentRating
				reduser.losses = reduser.losses+1
				blackuser.wins = blackuser.wins+1
			}
			if ( outcome.winner === "draw" ) {
				reduser.draws = reduser.draws+1
				blackuser.draws = blackuser.draws+1
			}
			mysql_update_user_ranked(reduser.userid, reduser.elo, outcome.winner=== "red"? "wins" : outcome.winner==="draw"?"draws": "losses", outcome.winner=== "red"? reduser.wins : outcome.winner==="draw"?  reduser.draws :  reduser.losses)
			mysql_update_user_ranked(blackuser.userid, blackuser.elo,  outcome.winner=== "black"? "wins" : outcome.winner==="draw"?"draws": "losses", outcome.winner=== "black"? blackuser.wins : outcome.winner==="draw"?  blackuser.draws :  blackuser.losses)
			io.to(reduser.current_socketid).emit("server_update_elo", reduser.elo)
			io.to(blackuser.current_socketid).emit("server_update_elo", blackuser.elo)
		}
	}

	var conclusion = outcome.winner === "red" ? "r" : outcome.winner === "black" ? "b" : outcome.winner === "draw" ? "d" : ""
	conclusion += (outcome.event === "malus" ? "m" : outcome.event === "stock" ? "s" : outcome.event === "surrender" ? "s" : outcome.event === "timer" ? "t" : "")

	io.to(active_rooms[index].red_user.current_socketid).emit("server_game_end", {
		winner: outcome.winner,
		conclusion : conclusion
	})
	io.to(active_rooms[index].black_user.current_socketid).emit("server_game_end", {
		winner: outcome.winner,
		conclusion : conclusion
	})
	var gameid = await mysql_insert_newgame(reduser ? reduser.userid : "NULL", blackuser ? blackuser.userid : "NULL", active_rooms[index].settings.initial_game_pon+PON.PON_from_actions(active_rooms[index].actions)+"="+conclusion, active_rooms[index].game_started, reduser && blackuser && active_rooms[index].settings.mode === "ranked" ? reduser.elo : "NULL", reduser && blackuser && active_rooms[index].settings.mode === "ranked" ? blackuser.elo : "NULL")
	if (reduser || blackuser) {
		var replay = {
			PON: active_rooms[index].settings.initial_game_pon+ PON.PON_from_actions(active_rooms[index].actions)+"="+conclusion,
			b: blackuser ? blackuser.username : null,
			be: blackuser ? blackuser.elo : null,
			r: reduser ? reduser.username : null,
			re: reduser ? reduser.elo : null,
			started: active_rooms[index].game_started,
		}
		if(reduser)
			io.to(active_rooms[index].red_user.current_socketid).emit("server_update_history", replay)
		if(blackuser)
			io.to(active_rooms[index].black_user.current_socketid).emit("server_update_history", replay)
	}
	
	for (var s of active_rooms[index].spectators) {
		if (s.initial_black_socketid === active_rooms[index].black_user.initial_socketid && s.initial_red_socketid === active_rooms[index].red_user.initial_socketid) {
			io.to(s.socketid).emit("server_game_end", {
				outcome: outcome,
				conclusion : conclusion
			})
		}
	}
	
	active_rooms.splice(index, 1)
	update_activerooms_onclients()
}

function pending_rooms_client() {
	var pending_rooms_client = [];
	for (var room of pending_rooms) {
		pending_rooms_client.push(JSON.parse(JSON.stringify(room)))
		pending_rooms_client[pending_rooms_client.length - 1].settings.secret = pending_rooms_client[pending_rooms_client.length - 1].settings.secret.length > 0 ? true : false
	}
	return pending_rooms_client
}


function active_rooms_client() {
	var pending_rooms_client = []
	for (var room of active_rooms) {
		if (true || room.settings.mode === "ranked") {
			var new_room = {
				name : room.settings.name,
				red_username: room.red_user.username,
				black_username: room.black_user.username,
				initial_black_socketid: room.black_user.initial_socketid,
				initial_red_socketid: room.red_user.initial_socketid,
			}
			pending_rooms_client.push(new_room)
		}
	}
	return pending_rooms_client
}


class Card {
	constructor(color, suit, value) {
		this.color = color;
		this.suit = suit;
		this.value = value;
		this.faceup = true;
	}
}

function freshDeck(color) {
	const suits = ["hearts", "diamonds", "spades", "clubs"];
	const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
	return suits.flatMap(suit => {
		return values.map(value => {
			return new Card(color, suit, value)
		});
	});
}

function shuffle(array) {
	var currentIndex = array.length,
		randomIndex;
	while (0 !== currentIndex) {
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex--;
		[array[currentIndex], array[randomIndex]] = [
			array[randomIndex], array[currentIndex]
		];
	}
	return array;
}

function sqlCompatibleDate(date) {
	var sqlcompatibledate = date;
	return sqlcompatibledate = sqlcompatibledate.getUTCFullYear() + '-' +
		('00' + (sqlcompatibledate.getUTCMonth() + 1)).slice(-2) + '-' +
		('00' + sqlcompatibledate.getUTCDate()).slice(-2) + ' ' +
		('00' + sqlcompatibledate.getUTCHours()).slice(-2) + ':' +
		('00' + sqlcompatibledate.getUTCMinutes()).slice(-2) + ':' +
		('00' + sqlcompatibledate.getUTCSeconds()).slice(-2);
}

function mysql_select_user_email(email) {
	return new Promise((resolve) => {
		dbconnection.query("SELECT * FROM users WHERE ( " +
			"email     =  " + "'" + email + "'" + " );",
			function(err, result) {
				if (err) {
					console.log(err)
					resolve({})
				} else resolve(result.length > 0 ? result[0] : {})
			}
		)
	})
}

function mysql_select_userhistory(userid) {
	return new Promise((resolve) => {
		dbconnection.query(
			"SELECT g.gameid as id, g.started, g.game_pon as PON, u1.username as r, u2.username as b, g.redelo as re, g.blackelo as be " +
			"FROM games g left JOIN users u1 ON u1.userid = g.userid1FK left JOIN users u2 ON u2.userid = g.userid2FK " +
			"WHERE userid1FK = " + userid + " or userid2FK = " + userid + " " +
			"ORDER BY gameid desc limit 20",
			function(err, result_games) {
				if (err) {
					console.log(err)
					resolve(false)
				} else {
					if (result_games.length > 0) {
						resolve({
							games: result_games,
						})
					} 
					else
						resolve(false)
				}
			}
		)
	})
}

function mysql_select_games() {
	return new Promise((resolve) => {
		dbconnection.query("SELECT * FROM games;",
			function(err, result) {
				if (err) {
					console.log(err)
					resolve({})
				} else {
					console.log("selected games")
					resolve(result.length > 0 ? result : {})
				}
			}
		)
	})
}

function mysql_select_user_usernamepassword(login, password) {
	return new Promise((resolve) => {
		dbconnection.query("SELECT * FROM users WHERE ( " +
			"username     =  " + "'" + login + "'" + " AND " +
			"password   =  " + "'" + password + "'" + " );",
			function(err, result) {
				if (err) {
					console.log(err)
					resolve({})
				} else {
					console.log("user logged in")
					resolve(result.length > 0 ? result[0] : {})
				}
			}
		)
	})
}

function mysql_select_user_leaderboard() {
	return new Promise((resolve) => {
		dbconnection.query("SELECT username, elo FROM users order by elo desc limit 50;",
			function(err, result) {
				if (err) {
					console.log(err)
					resolve([])
				} else resolve(result.length > 0 ? result : [])
			}
		)
	})
}

function mysql_update_userpw(userid, password) {
	dbconnection.query("UPDATE users SET password =" + "'" + password + "'" + " WHERE userid =" + userid,
		function(err, result) {
			if (err) console.log(err)
			else return true
		}
	)
}

function mysql_update_user_ranked(userid, elo, outcome, outcome_nr) {
	dbconnection.query("UPDATE users SET elo =" + elo + " WHERE userid =" + userid,
		function(err, res1) {
			if (err) console.log(err)
			else {
				console.log("Updated elo of user "+userid)
				dbconnection.query("UPDATE users SET " +outcome+  " = " +outcome_nr + " WHERE userid =" + userid,
					function(err, res2) {
						if (err) console.log(err)
						else {
							console.log("Updated " +outcome+" of user "+userid)
							return true
						}
					}
				)
			}
		}
	)
}

function mysql_insert_newuser(username, password, email) {
	var created = new Date()
	var new_player_elo = 1200 // new user elo value
	return new Promise((resolve) => {
		dbconnection.query("INSERT INTO users VALUES ( " +
			"0" + " ," +
			"'" + username + "'" + ", " +
			"'" + password + "'" + ", " +
			"'" + email + "'" + ", " +
			0 + ", " +
			0 + ", " +
			0 + ", " +
			new_player_elo + ", " +
			"'" + sqlCompatibleDate(created) + "'" + "); ",
			function(err, result) {
				if (err) resolve({});
				else {
					console.log("inserted user")
					result.insertId != -1 ? resolve({
						userid: result.insertId,
						username: username,
						password: password,
						email: email,
						wins: 0,
						losses: 0,
						draws: 0,
						elo: new_player_elo,
						created: sqlCompatibleDate(created)
					}) : resolve({});
				}
			}
		)
	})
}

function mysql_insert_newgame(userid1, userid2, game_pon, started, redelo, blackelo) { //elo value after game ended and elo adjusted. only defined if ranked
	return new Promise((resolve) => {
		dbconnection.query("INSERT INTO games VALUES ( " +
			"0" + " ," +
			userid1 + ", " +
			userid2 + ", " +
			redelo + ", " + 
			blackelo + ", " + 
			"'" + game_pon + "'" + ", " +
			"'" + started.toISOString() + "'" + ", " +
			"'" + new Date().toISOString() + "'" + " );",
			function(err, result) {
				if (err) {
					console.log(err)
					resolve(false);
				} else {
					console.log("inserted game")
					result.insertId != -1 ? resolve(result.insertId) : resolve(result.insertId);
				}

			}
		)
	})
}

function mysql_insert_users_table() {
	return new Promise((resolve) => {
		dbconnection.query("CREATE TABLE IF NOT EXISTS users (" +
			"userid          INT AUTO_INCREMENT PRIMARY KEY, " +
			"username        VARCHAR(20) UNIQUE, " +
			"password        VARCHAR(64), " +
			"email           VARCHAR(50) UNIQUE, " +
			"wins            int, " +
			"losses          int, " +
			"draws           int, " +
			"elo             int, " +
		//	"about           VARCHAR(999),  " +
			"created         DATETIME) ",
			function(err) {
				if (err) {
					console.error('table "users" creation failed ' + err.stack);
					return;
				} else console.log('table "users" created')
				resolve()
			}
		);
	})
}

function mysql_insert_games_table() {
	return new Promise((resolve) => {
		dbconnection.query("CREATE TABLE IF NOT EXISTS games (" +
			"gameid INT AUTO_INCREMENT PRIMARY KEY, " +
			"userid1FK INT, " +
			"userid2FK INT, " +
			"redelo INT, " +
			"blackelo INT, " +
			"game_pon VARCHAR(50000), " +
			"started varchar(24), " +
			"ended varchar(24), " +
			"CONSTRAINT `games_to_usersFK1` FOREIGN KEY (`userid1FK`) REFERENCES `users`(`userid`)," +
			"CONSTRAINT `games_to_usersFK2` FOREIGN KEY (`userid2FK`) REFERENCES `users`(`userid`))",
			function(err) {
				if (err) {
					console.error('table "games" creation failed ' + err.stack);
					return;
				} else console.log('table "games" created')
				resolve()
			}
		);
	})
}