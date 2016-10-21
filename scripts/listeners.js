//set env
var dotenv = require('node-env-file');
var env = process.env.NODE_ENV || 'development';

if (env !== "production") {
    dotenv('.env');
}

var _         = require('lodash');
var async     = require('async');
var Hashids   = require('hashids');
var mock_data = require('./stubs.js');
var moment    = require('moment');
var NRP       = require('node-redis-pubsub');
var request   = require('request');


// set globals
var CHANNEL_ID;
var PLAYER_ROLES = {wolf: "wolf", healer: "healer", seeker: "seeker", villager: "villager"};
var PLAYER_HEALTH = {alive: "alive", dead: "dead"};
var DEFAULT_CHANNEL = "C2RF9N334";
var DEFAULT_TIMEOUT = 10000;
var DEFAULT_GAMEID = "WOLFEY";


//bot listeners
function bot(robot) {

    robot.respond(/delete brain/i, function (res) {
        robot.brain.data.games = {};
        res.send("brain deleted");
    });

    //Start Game
    robot.respond(/new game/i, function (res) {
        var hashids = new Hashids();
        var random_int = Date.now();
        // var gameId = hashids.encode(random_int);
        var gameId = DEFAULT_GAMEID;

        if(robot.brain.data.games == null) {
            robot.brain.data.games = {};
        }
        robot.brain.data.games[gameId] = {players: [], status: "on"};

        robot.emit("join", gameId);
    });

    robot.on("join", function(gameId) {
        robot.messageRoom(DEFAULT_CHANNEL, "@here New wolf game starting! To join, DM me with the command: `join` In 2 minutes, registration will be over!");
        
        robot.brain.data.games[gameId].currentHealedPlayer = "";
        robot.brain.data.games[gameId].WOLVES_DM = "";
        robot.brain.data.games[gameId].HEALER_DM = "";
        robot.brain.data.games[gameId].SEEKER_DM = "";
        robot.brain.data.games[gameId].wolfIds = [];

        robot.respond(/join/i, function (res) {
            var name = res.message.user.name;
            var id = res.message.user.id;
            var newPlayer = {name: name, id: id, health: PLAYER_HEALTH.alive};
            robot.brain.data.games[gameId].players.push(newPlayer);

            //TODO thank player for joining
            res.send('Thanks @' + name + " for joining! I'm waiting for other players to join so I can assign your role!");
        });

        setTimeout(function() {
            //TODO block users from joining a game in session
            //TODO unique users
            console.log("time out to join");
            robot.messageRoom(DEFAULT_CHANNEL, "@here Registration is now over! Sending you all DMs with your new roles ;)");
            console.log("players", robot.brain.data.games[gameId].players);
            robot.emit("assign roles");
            return true;
        }, 20000);
    });

    robot.on("assign roles", function() {
        console.log("assign roles");
        //send DMs, inform channel of number of players, wolves, healers. etc
        var gameId = DEFAULT_GAMEID;
        generateRoleIndexesAndAssign(robot);
        var ids = robot.brain.data.games[gameId].wolfIds;
        if(ids.length > 1){
            createMultiParty(ids, function(multiDM) {
                console.log("WOLVES DM IS", multiDM);
                robot.brain.data.games[gameId].WOLVES_DM = multiDM;
                robot.emit("village sleep");
            });
        }
        else {
            var wolfId = robot.brain.data.games[gameId].players[wolfIds[0]].id;
            robot.brain.data.games[gameId].WOLVES_DM = wolfId;
            robot.emit("village sleep");
        }
        console.log("players", robot.brain.data.games[gameId].players);
    });

    robot.on("village sleep", function() {
        //the village goes to sleep
        robot.messageRoom(DEFAULT_CHANNEL, "It's midnight :crescent_moon: The villagers go to sleep :sleepy: :sleeping:");
        robot.emit("wolves wake up");
    });

    robot.on("wolves wake up", function() {
        //the wolves wake up and select someone to kill
        robot.messageRoom(DEFAULT_CHANNEL, "The wolves come out. They acknowledge themselves :wolf-thumbs-up: They decide on who to kill");
        var gameId = DEFAULT_GAMEID;
        var wolvesDMChannel = robot.brain.data.games[gameId].WOLVES_DM;
        console.log("wolves wake up", wolvesDMChannel);
        robot.messageRoom(wolvesDMChannel, "Meal Time! Discuss amongst yourselves and one of you can issue the final kill command: `kill <username>` You have 20 seconds");
        
        robot.hear(/kill (.*)/i, function (res) {
            var killedPlayer = res.match[1];
            robot.brain.data.games[gameId].currentKilledPlayer = killedPlayer;
            res.send("You have decided to kill " + killedPlayer + ". :wolf-thumbs-up:");    
        });

        setTimeout(function() {
            //trigger healer event
            robot.messageRoom(DEFAULT_CHANNEL, "The wolves have decided on who to kill");
            console.log("wolves decided to kill ", robot.brain.data.games[gameId].currentKilledPlayer);
            robot.emit("healer");
            return true;
        }, 20000);


    });

    robot.on("healer", function () {
        //the healer wakes up to heal a player from speculated wolf attacks
        console.log("healer wakes up");
        robot.messageRoom(DEFAULT_CHANNEL, "It's 2am in the morning. The healer wakes up and feels led to heal someone");
        var gameId = DEFAULT_GAMEID;
        var healerDMChannel = robot.brain.data.games[gameId].HEALER_DM;
        robot.messageRoom(healerDMChannel, "Heal a fellow villager with the command: `heal <username>` You have 20 seconds");

        robot.respond(/heal (.*)/i, function (res) {
            var healedPlayer = res.match[1];
            robot.brain.data.games[gameId].currentHealedPlayer = healedPlayer;
            res.send("You have healed " + healedPlayer + ". :pill:");
            
        });
        setTimeout(function() {
            //trigger seeker event
            robot.messageRoom(DEFAULT_CHANNEL, "The healer has picked someone to heal :pill:");
            console.log("healer decided to heal ", robot.brain.data.games[gameId].currentHealedPlayer);
            robot.emit("seeker");
            return true;
        }, DEFAULT_TIMEOUT);
    });


    robot.on("seeker", function (seeker) {
        //the seeker wakes up to consult the oracle
        console.log("seeker wakes up");
        var suspect = "";
        robot.messageRoom(DEFAULT_CHANNEL, "It's 3am in the morning. The seeker wakes up to consult the oracle");
        var gameId = DEFAULT_GAMEID;
        var seekerDMChannel = robot.brain.data.games[gameId].SEEKER_DM;
        robot.messageRoom(seekerDMChannel, "Chosen one, ask the Oracle to reveal who the wolf is with the command: `seek <suspect_username>` You have 20 seconds");
        
        robot.respond(/seek (.*)/i, function (res) {
            console.log("suspect received");
            suspect = res.match[1];
            var suspectObj = _.find(robot.brain.data.games[DEFAULT_GAMEID].players, {name: suspect});
            var isWolf = suspectObj.role === PLAYER_ROLES.wolf;

            if(isWolf) {
                res.send("Yes, " + suspect + " is a wolf!");
            }
            else {
                res.send("No, " + suspect + " is not a wolf!");
            }
        });
        setTimeout(function() {
            //trigger awake event
            robot.messageRoom(DEFAULT_CHANNEL, "The seeker goes back to sleep");
            console.log("seeker asked for", suspect);
            robot.emit("finalize wolf kill");
            return true;
        }, 20000);
    });

    robot.on("finalize wolf kill", function () {
        var gameId = DEFAULT_GAMEID;
        var killedPlayer = robot.brain.data.games[gameId].currentKilledPlayer;
        var healedPlayer = robot.brain.data.games[gameId].currentHealedPlayer;

        if(killedPlayer != healedPlayer) {
            killPlayer(killedPlayer);
            robot.emit("awake with deaths", killedPlayer);
        }
        else {
            robot.emit("awake no deaths");
        }

    });

    robot.on("awake no deaths", function() {
        //the village wakes up
        robot.messageRoom(DEFAULT_CHANNEL, "It's morning! :sun_small_cloud:  The village wakes up! :rooster:");
        robot.messageRoom(DEFAULT_CHANNEL, "Nobody died last night!");
        //trigger banter
        robot.emit("banter");
    });

    robot.on("awake with deaths", function(killedPlayer) {
        //the village wakes up
        robot.messageRoom(DEFAULT_CHANNEL, "It's morning! :sun_small_cloud:  The village wakes up! :rooster:");
        robot.messageRoom(DEFAULT_CHANNEL, "Sadly, @" + killedPlayer + " died last night! :skull:");
        //trigger banter
        robot.emit("banter");
    });
    
    robot.on("banter", function() {
        //3 mins: players converse in channel to accuse and defend themselves
        robot.messageRoom(DEFAULT_CHANNEL, "There are still wolves in the village! Discuss amongst each other to find out who the wolf is. In 2 mins, you'll have the chance to vote who you think the wolf is for execution");
        setTimeout(function() {
            //trigger awake event
            // robot.emit("voting");
            return true;
        }, 20000);

    }); 

    robot.on("voting", function() {
        //players nominate a player that they think is a wolf
        robot.messageRoom(DEFAULT_CHANNEL, "It's vigilante justice time! Send me a DM with the command: `vote <suspect_username>` to nominate a suspect");
        var gameId = DEFAULT_GAMEID;
        robot.brain.data.games[gameId].currentRoundVotes = [];
        robot.respond(/vote (.*)/i, function (res) {
            var player = res.match[1];
            robot.brain.data.games[gameId].currentRoundVotes.push(player);
        });
        setTimeout(function() {
            robot.messageRoom(DEFAULT_CHANNEL, "Voting is over!");
            
            robot.emit("execution");
            return true;
        }, 20000);

    });

    robot.on("execution", function() {
        //notifies channel of who the vote executed, triggers loop
        //calculate player with most votes and kill them
        var gameId = DEFAULT_GAMEID;
        var playerWithMostVotes = getPlayerWithMostVotes(robot.brain.data.games[gameId].currentRoundVotes);
        killPlayerByVotes(robot, playerWithMostVotes);

        robot.messageRoom(DEFAULT_CHANNEL, "By popular demand, @" + playerWithMostVotes + " has been executed! :knife: :cry:");
        robot.emit("new round");
    });

    robot.on("new round", function() {
        //Calculate number of wolves vs villagers still in the game. Determine whether to end game or continue
        var gameId = DEFAULT_GAMEID;
        var numWolves = countWolves(robot);
        var numVillagers = countVillagers(robot, numWolves);

        if(numVillagers < numWolves) {
            //wolves win
            robot.messageRoom(DEFAULT_CHANNEL, "GAME OVER! The wolves win! :wolf-thumbs-up:");
            robot.brain.data.games[gameId].status = "off";
        }
        else if(numWolves === 0) {
            robot.messageRoom(DEFAULT_CHANNEL, "GAME OVER! All the wolves are dead so the villagers win! :raised_hands:");
            robot.brain.data.games[gameId].status = "off";
        }
        else {
            robot.emit("village sleep");
        }
        
    });
}

function textifyActivePlayers(players) {
    var activePlayers = _.filter(players, {health: PLAYER_HEALTH.alive});
    var activePlayerNames = _.map(activePlayers, 'name');
    return _.join(activePlayerNames, "\n");
}

function countWolves(robot) {
    var gameId = DEFAULT_GAMEID;
    var wolves = _.filter(robot.brain.data.games[gameId].players, {role: PLAYER_ROLES.wolf, health: PLAYER_HEALTH.alive});
    return wolves.length;
}

function countVillagers(robot) {
    var gameId = DEFAULT_GAMEID;
    var aliveVillagers = _.filter(robot.brain.data.games[gameId].players, {role: PLAYER_ROLES.villager, health: PLAYER_HEALTH.alive});
    var aliveHealer = _.filter(robot.brain.data.games[gameId].players, {role: PLAYER_ROLES.healer, health: PLAYER_HEALTH.alive});
    var aliveSeeker = _.filter(robot.brain.data.games[gameId].players, {role: PLAYER_ROLES.seeker, health: PLAYER_HEALTH.alive});
    var numVillagers = aliveVillagers.length + aliveHealer.length + aliveSeeker.length;

    return numVillagers - numWolves;
}

function killPlayer(robot, playerName) {
    var gameId = DEFAULT_GAMEID;
    var player = _.find(robot.brain.data.games[gameId].players, {name: playerName});
    player.health = PLAYER_HEALTH.dead;
}

function sendPlayerDeadNotice(robot, playerName) {
    var deathMessage = "@" + player + " is dead! :skull:";
    robot.messageRoom(DEFAULT_CHANNEL, "@" + player + "");
}

function killPlayerByVotes(robot, playerName) {
    //TODO: consider case where votes yielded no clear winner
    killPlayer(robot, playerName);
    sendPlayerDeadNotice(robot, playerName);
}

function getPlayerWithMostVotes(votes) {
    return _.chain(votes).countBy().pairs().max(_.last).head().value();
}

function generateWolfIndexes(numWolves, numPlayers) {
    wolfIndexes = [];

    for(var i = 0; i < numWolves; i++) {
        var index = Math.round(Math.random() * (numPlayers - 1));

        while(wolfIndexes.indexOf(index) > -1) {
            index  = Math.round(Math.random() * (numPlayers - 1));
        }

        wolfIndexes.push(index);
    }

    return wolfIndexes;
}

function generateHealerIndex(wolfIndexes, numPlayers) {
    var healerIndex  = Math.round(Math.random() * (numPlayers - 1));

    while(wolfIndexes.indexOf(healerIndex) > -1) {
        healerIndex  = Math.round(Math.random() * (numPlayers - 1));
    }

    return healerIndex;
}

function generateSeekerIndex(wolfIndexes, healerIndex, numPlayers) {
    var seekerIndex  = Math.round(Math.random() * (numPlayers - 1));

    while(wolfIndexes.indexOf(seekerIndex) > -1 || seekerIndex === healerIndex) {
        seekerIndex  = Math.round(Math.random() * (numPlayers - 1));
    }

    return seekerIndex;
}

function notifyPlayerOfRole(robot, slackId, role) {
    //TODO edit message based
    var message = "Thanks for joining the game! In this game, you're a ";
    switch(role) {
        case PLAYER_ROLES.wolf:
            message += "wolf! :wolf-thumbs-up:"
            break;
        case PLAYER_ROLES.healer:
            message += "healer! :pill:"
            break;
        case PLAYER_ROLES.seeker:
            message += "seeker! :wizard:"
            break;
        default:
            message += "villager ¯\\_(ツ)_/¯"
    }
    robot.messageRoom(slackId, message);
}

//refactor to modify player roles in place
function assignRolesAndNotifyPlayers(robot, wolfIndexes, healerIndex, seekerIndex) {

    var gameId = DEFAULT_GAMEID;
    var players = robot.brain.data.games[gameId].players;

    console.log("assignRolesAndNotifyPlayers", players);

    for(var playerIndex in players) {
        var intPlayerIndex = Number(playerIndex); // because for in keys are strings
        players[intPlayerIndex].role = PLAYER_ROLES.villager;
        
        if(wolfIndexes.indexOf(intPlayerIndex) > -1) {
            players[intPlayerIndex].role = PLAYER_ROLES.wolf;
            notifyPlayerOfRole(robot, players[intPlayerIndex].id, PLAYER_ROLES.wolf);
        }
        else if(intPlayerIndex === healerIndex) {
            players[intPlayerIndex].role = PLAYER_ROLES.healer;
            notifyPlayerOfRole(robot, players[intPlayerIndex].id, PLAYER_ROLES.healer);
        }
        else if(intPlayerIndex === seekerIndex) {
            players[intPlayerIndex].role = PLAYER_ROLES.seeker;
            notifyPlayerOfRole(robot, players[intPlayerIndex].id, PLAYER_ROLES.seeker);
        }
        else {
            notifyPlayerOfRole(robot, players[intPlayerIndex].id, PLAYER_ROLES.villager);
        }
    }
}

function generateRoleIndexesAndAssign(robot) {
    var gameId = DEFAULT_GAMEID;
    var players = robot.brain.data.games[gameId].players;
    var numPlayers = players.length;
    var numWolves = Math.floor(0.3 * numPlayers);

    var wolfIndexes = generateWolfIndexes(numWolves, numPlayers);
    var healerIndex = generateHealerIndex(wolfIndexes, numPlayers);
    var seekerIndex = generateSeekerIndex(wolfIndexes, healerIndex, numPlayers);

    assignRolesAndNotifyPlayers(robot, wolfIndexes, healerIndex, seekerIndex);
    robot.brain.data.games[gameId].wolfIndexes = wolfIndexes;
    robot.brain.data.games[gameId].healerIndex = healerIndex;
    robot.brain.data.games[gameId].seekerIndex = seekerIndex;
    robot.brain.data.games[gameId].wolfIds = getWolfIds(robot, players, wolfIndexes);
    setUpHealerDM(robot, players, healerIndex);
    setUpSeekerDM(robot, players, seekerIndex);

}

function createMultiParty(slackIds, cb) {
    params = {
        url: "https://slack.com/api/mpim.open",
        headers: {
            'Content-Type': 'application/json'
        },
        qs: {
            users: slackIds.join(","),
            token: process.env.HUBOT_SLACK_TOKEN
        }
    }
    request.get(params, function (err, status, body){
        console.log(err, body);
        console.log("Multi Party Channel");
        body = JSON.parse(body);
        console.log(body.group.id);
        cb(body.group.id);
    })
}

function getWolfIds(robot, players, wolfIndexes) {
    var gameId = DEFAULT_GAMEID;
    var ids = [];
    for (var i in wolfIndexes) {
        console.log("setting up wolves DM", wolfIndexes, wolfIndexes[i], players, players[wolfIndexes[i]], players[wolfIndexes[i]].id);
        ids.push(players[wolfIndexes[i]].id);
    }
    return ids;
}

function setUpWolvesDM(robot, players, wolfIndexes) {
    createMultiParty(ids, function(multiDM) {
        console.log("WOLVES DM IS", multiDM);
        robot.brain.data.games[gameId].WOLVES_DM = multiDM;
    });
}

function setUpHealerDM(robot, players, healerIndex) {
    var gameId = DEFAULT_GAMEID;
    var healerId = players[healerIndex].id;
    robot.brain.data.games[gameId].HEALER_DM = healerId;
}

function setUpSeekerDM(robot, players, seekerIndex) {
    var gameId = DEFAULT_GAMEID;
    var seekerId = players[seekerIndex].id;
    robot.brain.data.games[gameId].SEEKER_DM = seekerId;
}


module.exports = bot;