///////////////////////////////////////////////////////////////////////
// https://discord.js.org/#/

const Discord = require('discord.js')
const discordClient = new Discord.Client()

let sendDiscord = (channelName, message) => {
	console.log("discord client not ready for sending", channelName, message)
}

discordClient.on('ready', _ => {
	console.log(`Discord bot logged in as ${discordClient.user.tag}!`)
	
	sendDiscord = (channelName, message) => {
		const channel = discordClient.channels.cache.find(channel => channel.name === channelName)
		
		channel.send(message)
	}
	
	if(process.env.SEND_LOGIN_MESSAGE) sendDiscord("bot-log", "bot logged in")
})

discordClient.on('message', msg => {
	if (msg.content === 'ping') {
		msg.reply('pong!')
	}
})

if(process.env.DISCORD_BOT_TOKEN){
	discordClient.login(process.env.DISCORD_BOT_TOKEN)
}

///////////////////////////////////////////////////////////////////////

const classes = require("./classes.js")

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

class Transactions{
	constructor(props){				
		this.props = props
		
		this.bannedUsers = props.bannedUsers || []
		this.bannedPolls = props.bannedPolls || []
		
		this.quotas = this.props.quotas
		
		this.transactions = []
	}
	
	isOk(transaction){
		if(transaction.verifiedUser){
			if(this.bannedUsers.includes(transaction.verifiedUser.id)) return false
			if(this.bannedUsers.includes(transaction.verifiedUser.username)) return false
		}
		
		if(transaction instanceof classes.CreatePoll_){
			if(this.bannedPolls.includes(transaction.pollId)) return false
		}
		
		return true
	}
	
	add(transaction){
		this.transactions.unshift(transaction)
	}
	
	isExhausted(user){		
		for(let quota of this.quotas) quota.init()
		
		let filteredTransactions = this.transactions.filter(transaction => {
			return true
		})
		
		for(let transaction of filteredTransactions){
			for(let quota of this.quotas){
				if(quota.isExhausted(user, transaction)){
					return true
				}
			}
		}
		
		return false
	}
}

class TransactionQuota{
	constructor(props){
		this.props = props
		
		this.span = this.props.span
		this.cap = this.props.cap
	}
	
	init(){
		this.count = 0
		this.now = new Date().getTime()
	}
	
	isExhausted(user, transaction){		
		if(!transaction.verifiedUser.equalTo(user)) return false
		
		let elapsed = this.now - transaction.createdAt
		
		if(elapsed < this.span){
			this.count ++
			
			if(this.count > this.cap){
				return true
			}
		}
	}
}

const TRANSACTIONS = new Transactions({
	bannedUsers: process.env.BANNED_USERS ? process.env.BANNED_USERS.split(" ") : [],
	bannedPolls: process.env.BANNED_POLLS ? process.env.BANNED_POLLS.split(" ") : [],
	quotas: [
		new TransactionQuota({
			span: 10 * MINUTE,
			cap: 20
		}),
		new TransactionQuota({
			span: 30 * SECOND,
			cap: 5
		})
	]
})

function IS_PROD(){
	return !!process.env.SITE_HOST
}

const sse = require('@easychessanimations/sse')

const express = require('express')
const app = express()
const port = parseInt(process.env.PORT || "3000")

const MongoClient = require('mongodb').MongoClient
const uri = process.env.MONGODB_URI
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true })

const passport = require('passport')
const LishogiStrategy = require('passport-lishogi').Strategy
const DiscordStrategy = require('passport-discord').Strategy
const GithubStrategy = require('passport-github').Strategy

let STATE = classes.State()

client.connect(err => {
	if(err){
		console.error("MongoDb connection failed", err)
	}else{
		console.log("MongoDb connected!")		
		client.db("app").collection("transactions").find({}).toArray().then(result => {
			console.log("retrieved all transactions", result.length)
			for(let transactionBlob of result){
				let transaction = classes.transactionFromBlob(transactionBlob)				
				if(TRANSACTIONS.isOk(transaction)) STATE.executeTransaction(transaction)
			}
		}, err => console.error("getting all transactions failed", err))
	}
})

app.use(require('cookie-parser')())

app.use(require('body-parser').json())

app.use(require('body-parser').urlencoded({ extended: true }))

const session = require('express-session')    

const MongoStore = require('connect-mongo')(session)

const mongoStoreOptions = {
	client: client,
	dbName: "mongodbtestserveroauth",
	collection: "users"
}

const sessionProps= {
	secret: 'keyboard cat',
	resave: process.env.RESAVE == "true",
	saveUninitialized: process.env.SAVE_UNINITIALIZED == "true",
	cookie: {
		maxAge: parseInt( process.env.COOKIE_MAX_AGE || 1 * 366 * 31 * 24 * 60 * 60 * 1000 )
	},
	store: new MongoStore(mongoStoreOptions)
}

app.use(session(sessionProps))

app.use(passport.initialize())

app.use(passport.session())

passport.serializeUser(function(user, cb) {
    cb(null, user)
})
  
passport.deserializeUser(function(obj, cb) {
    cb(null, obj)
})

function getHostProtAndUrl(props){
    let host = process.env.SITE_HOST || props.SITE_HOST || "localhost:3000"
    let prot = host.match(/^localhost:/) ? "http://" : "https://"
    let url = prot + host + props.authURL
    return [host, prot, url]
}

function addStrategy(app, props, strategy){
    let [host, prot, url] = getHostProtAndUrl(props)
	
	let strategyProps = {
        clientID: props.clientID,
        clientSecret: props.clientSecret,
        callbackURL: url + "/callback",
        scope: props.scope || ""
	}
	
	let strategyFunc = (accessToken, refreshToken, profile, cb) => {
		console.log(`id : ${profile.id}\naccessToken : ${accessToken}\nrefreshToken : ${refreshToken}`)

		profile.accessToken = accessToken

		let connectTransaction = classes.Transaction()

		connectTransaction.author = classes.User(profile)
		connectTransaction.verifiedUser = classes.User(profile)

		connectTransaction.topic = "oauthLogin"

		client.db("app").collection("transactions").insertOne(connectTransaction.serialize()).then(result => {

		})

		return cb(null, profile)
	}

    passport.use(props.tag, new strategy(strategyProps, strategyFunc))
	
	app.get(props.authURL,
        passport.authenticate(props.tag))

    app.get(props.authURL + "/callback", 
        passport.authenticate(props.tag, { failureRedirect: prot + host + props.failureRedirect }),
            function(req, res) {
				console.log("auth req user", req.user)
		
				res.redirect(prot + host + props.okRedirect)
            }
    )
}

if(process.env.LISHOGI_CLIENT_ID) addStrategy(app, {
    tag: "lishogi",
    clientID: process.env.LISHOGI_CLIENT_ID || "some client id",
    clientSecret: process.env.LISHOGI_CLIENT_SECRET || "some client secret",
    authURL: "/auth/lishogi",
	scope: "",
    failureRedirect: "/?lishogilogin=failed",
    okRedirect: "/?lishogilogin=ok"
}, LishogiStrategy)

if(process.env.DISCORD_CLIENT_ID) addStrategy(app, {
    tag: "discord",
    clientID: process.env.DISCORD_CLIENT_ID || "some client id",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "some client secret",
    authURL: "/auth/discord",
	scope: "identify",
    failureRedirect: "/?discordlogin=failed",
    okRedirect: "/?discordlogin=ok"
}, DiscordStrategy)

if(process.env.GITHUB_CLIENT_ID) addStrategy(app, {
    tag: "discord",
    clientID: process.env.GITHUB_CLIENT_ID || "some client id",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "some client secret",
    authURL: "/auth/github",
	scope: "",
    failureRedirect: "/?githublogin=failed",
    okRedirect: "/?githublogin=ok"
}, GithubStrategy)

app.use("/", express.static(__dirname))

function apiSend(res, blob){
	res.set('Content-Type', 'application/json')
	
	res.send(JSON.stringify(blob))
}

app.use(sse.sseMiddleware)

sse.setupStream(app)

app.get('/logout', (req, res) => {
	req.logout()
	res.redirect("/")
})

app.post('/api', (req, res) => {
	let body = req.body
	
	let topic = body.topic
	
	let payload = body.payload
	
	if(topic == "getLatest"){
		client.db("app").collection("transactions").find().sort({"$natural": -1}).limit(payload.limit || 100).toArray().then(result => {
			console.log("retrieved latest transactions", result.length)
			apiSend(res, result)
		}, err => console.error("getting all transactions failed", err))
		
		return
	}
	
	if(IS_PROD() && (!req.user)){
		let msg = "Warning: You should be logged in to be able to use the API."
		
		console.warn(msg)
		
		apiSend(res, {
			warn: msg
		})
		
		return
	}
	
	console.info("api", topic, payload)
		
	if(topic == "addTransaction"){
		let ok = true
		
		let transaction = classes.transactionFromBlob(payload.transaction)
		
		transaction.createdAt = new Date().getTime()
		
		transaction.verifiedUser = classes.User(req.user)
		
		if(TRANSACTIONS.isExhausted(transaction.verifiedUser)){
			apiSend(res, {
				quotaExceeded: true
			})
			
			return
		}
		
		if(!TRANSACTIONS.isOk(transaction)) return
		
		TRANSACTIONS.add(transaction)
		
		sendDiscord("bot-log", "```json\n" + JSON.stringify({...transaction.serialize(), ...{author: undefined}}) + "\n```")
		
		client.db("app").collection("transactions").insertOne(transaction.serialize()).then(result => {
			if(ok){
				let result = STATE.executeTransaction(transaction)
				
				if(result){
					if((typeof result == "object") && result.error){
						apiSend(res, result)
						
						return
					}
				}
				
				sse.ssesend({
					topic: "setState",
					state: STATE.serialize()
				})	
				
				apiSend(res, {
					ok: true
				})
			}
		})
	}
})

app.get('/', (req, res) => {
	res.send(`
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Lishogi Straw Poll</title>    
    <script src="https://unpkg.com/@easychessanimations/foo@1.0.43/lib/fooweb.js"></script>
	<script src="https://unpkg.com/@easychessanimations/sse/lib/sseclient.js"></script>
	<link rel="stylesheet" href="style.css">
  </head>
  <body>

	<div style="padding: 3px; background-color: #eee; margin-bottom: 6px;">
		${req.user ? "logged in as <b>" + req.user.username + "</b> | <a href='/logout'>log out</a>" : "<a href='/auth/lishogi'>log in with lishogi</a> | <a href='/auth/discord'>log in with Discord</a> | <a href='/auth/github'>log in with GitHub</a>"} 
	| <a href="/?latest=true">view latest transactions</a> 
	| <a href="/">home</a>
	</div>

    <div id="root"></div>
	<hr>
	<a href="https://lishogi.org/@/YoBot_v2" rel="noopener noreferrer" target="_blank">YoBot_v2</a> | 
	<a href="https://github.com/TheYoBots/lishostrawpoll" rel="noopener noreferrer" target="_blank">GitHub Source Code</a>	
	<script>
		var USER = ${JSON.stringify(req.user || {}, null, 2)}
		var STATE = ${JSON.stringify(STATE.serialize(), null, 2)}
		var TICK_INTERVAL = ${sse.TICK_INTERVAL}
	</script>
	<script src="classes.js"></script>
	<script src="app.js"></script>
  </body>
</html>
`)
})

app.listen(port, () => {
	console.log(`mongodbtest listening at port ${port}`)
})
