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
var DEFAULT_CHANNEL = "C2M2XSY5Q";
var DEFAULT_TIMEOUT = 10000;
var DEFAULT_GAMEID = "WOLFEY";


//bot listeners
function bot(robot) {
    robot.hear(/test multidm/i, function(res) {
        var ids = ["U1N734ERK", "U02R7LM5U"];
        createMultiParty(ids, function(grp_id) {
            console.log("DM ID", grp_id);
            robot.messageRoom(grp_id, "TEST ROBOT MULTIDM: pls ignore");
        });
    });

    robot.hear(/test dm/i, function(res) {
        robot.messageRoom("U02R7LM5U", "TEST ROBOT SINGLEDM: pls ignore");
    });



    robot.respond(/delete brain/i, function (res) {
        robot.brain.data.games = {};
        res.send("brain deleted");
    });

    robot.respond(/show games/i, function (res) {
        var games = robot.brain.data.games;
        console.log('RES', res.message.user.id, res.message.user.name);
        res.send("check logs");
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

        robot.respond(/join/i, function (res) {
            var name = res.message.user.name;
            var id = res.message.user.id;
            var newPlayer = {name: name, id: id};
            robot.brain.data.games[gameId].players.push(newPlayer);
        });

        setTimeout(function() {
            robot.messageRoom(DEFAULT_CHANNEL, "@here Registration is now over! Sending you all DMs with your new roles ;)");
            robot.emit("assign roles");
            return true;
        }, 20000);
    });

    robot.on("assign roles", function() {
        //send DMs, inform channel of number of players, wolves, healers. etc
        generateRoleIndexesAndAssign(robot);
        robot.emit("village sleep");
    });

    robot.on("village sleep", function() {
        //the village goes to sleep
        robot.messageRoom(DEFAULT_CHANNEL, "It's midnight :crescent_moon: The villagers go to sleep :sleepy: :sleeping:");
        robot.emit("wolves wake up");
    });

    robot.on("wolves wake up", function() {
        //the wolves wake up and select someone to kill
        var wolvesDMChannel = robot.brain.data.games[gameId].WOLVES_DM;
        robot.messageRoom(wolvesDMChannel, "Meal Time! Discuss amongst yourselves and one of you can issue the final kill command: `kill <username>` You have 20 seconds");
        robot.respond(/kill (.*)/i, function (res) {
            var killedPlayer = res.match[1];
            robot.brain.data.games[gameId].currentKilledPlayer = killedPlayer;
            res.send("You have decided to kill " + killedPlayer + ". :wolf-thumbs-up:");    
        });
        setTimeout(function() {
            //trigger healer event
            robot.emit("healer");
            return true;
        }, DEFAULT_TIMEOUT);


    });

    robot.on("healer", function () {
        //the healer wakes up to heal a player from speculated wolf attacks
        var healerDMChannel = robot.brain.data.games[gameId].HEALER_DM;
        robot.messageRoom(healerDMChannel, "Heal a fellow villager with the command: `heal <username>` You have 20 seconds");

        robot.respond(/heal (.*)/i, function (res) {
            var healedPlayer = res.match[1];
            robot.brain.data.games[gameId].currentHealedPlayer = healedPlayer;
            res.send("You have healed " + healedPlayer + ". :pill:");
            
        });
        setTimeout(function() {
            //trigger seeker event
            robot.emit("seeker");
            return true;
        }, DEFAULT_TIMEOUT);
    });

    robot.on("seeker", function (seeker) {
        //the seeker wakes up to consult the oracle
        var seekerDMChannel = robot.brain.data.games[gameId].SEEKER_DM;
        robot.messageRoom(seekerDMChannel, "Chosen one, ask the Oracle to reveal who the wolf is with the command: `wolf? <suspect_username>` You have 20 seconds");
        robot.respond(/wolf? (.*)/i, function (res) {
            var suspect = res.match[1];
            var isWolf = robot.brain.data.games[DEFAULT_GAMEID].roles[suspect] === PLAYER_ROLES.wolf;

            if(isWolf) {
                res.send("Yes, " + suspect + " is a wolf!");
            }
            else {
                res.send("No, " + suspect + " is not a wolf!");
            }
        });
        setTimeout(function() {
            //trigger awake event
            robot.emit("awake");
            return true;
        }, DEFAULT_TIMEOUT);
    });


    robot.on("awake", function() {
        //the village wakes up
        robot.messageRoom(DEFAULT_CHANNEL, "It's morning! :sun_small_cloud:  The village wakes up! :rooster:");
        //TODO ANNOUNCE WHO DIED! OR WHO DID NOT
        robot.messageRoom(DEFAULT_CHANNEL, "Nobody died last night!");
        //trigger banter
    });
    
    robot.on("banter", function() {
        //3 mins: players converse in channel to accuse and defend themselves
        robot.messageRoom(DEFAULT_CHANNEL, "There are still wolves in the village! Discuss amongst each other to find out who the wolf is. In 2 mins, you'll have the chance to vote who you think the wolf is for execution");
        setTimeout(function() {
            //trigger awake event
            robot.emit("voting");
            return true;
        }, 20000);

    }); 

    robot.on("voting", function() {
        //players nominate a player that they think is a wolf
        robot.messageRoom(DEFAULT_CHANNEL, "It's vigilante justice time! Send me a DM with the command: `vote <suspect_username>` to nominate a suspect");
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
        var playerWithMostVotes = getPlayerWithMostVotes(robot.brain.data.games[gameId].currentRoundVotes);
        killPlayerByVotes(robot, playerWithMostVotes);

        robot.messageRoom(DEFAULT_CHANNEL, "By popular demand, @" + playerWithMostVotes + " has been executed! :knife: :cry:");
        robot.emit("new round");
    });

    robot.on("new round", function() {
        //Calculate number of wolves vs villagers still in the game. Determine whether to end game or continue
        var numWolves = countWolves();
        var numVillagers = countVillagers();

        if(numVillagers < numWolves) {
            //wolves win
            robot.messageRoom(DEFAULT_CHANNEL, "GAME OVER! The wolves win! :wolf-thumbs-up:");
            robot.brain.data.games[DEFAULT_GAMEID].status = "off";
        }
        else if(numWolves === 0) {
            robot.messageRoom(DEFAULT_CHANNEL, "GAME OVER! All the wolves are dead so the villagers win! :raised_hands:");
            robot.brain.data.games[DEFAULT_GAMEID].status = "off";
        }
        else {
            robot.emit("village sleep");
        }
        
    });
}

function countWolves() {
    return 3;
}

function countVillagers() {
    return 5;
}

function killPlayer(robot, player) {
    delete robot.brain.data.games[gameId].roles[player];
}

function sendPlayerDeadNotice(robot, player) {
    var deathMessage = "@" + player + " is dead! :skull:";
    robot.messageRoom(DEFAULT_CHANNEL, "@" + player + "");
}

function killPlayerByVotes(robot, player) {
    //TODO: consider case where votes yielded no clear winner
    killPlayer(robot, player);
    sendPlayerDeadNotice(robot, player);
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
            default message += "villager ¯\\_(ツ)_/¯"
    }
    robot.messageRoom(slackId, message);
}

//refactor to modify player roles in place
function assignRolesAndNotifyPlayers(robot, wolfIndexes, healerIndex, seekerIndex) {

    var players = robot.brain.data.games[DEFAULT_GAMEID].players;

    for(var playerIndex in players) {
        var intPlayerIndex = Number(playerIndex); // because for in keys are strings
        players[intPlayerIndex] = PLAYER_ROLES.villager;
        
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
    var players = robot.brain.data.games[DEFAULT_GAMEID].players;
    var numPlayers = players.length;
    var numWolves = Math.floor(0.3 * numPlayers);

    var wolfIndexes = generateWolfIndexes(numWolves, numPlayers);
    var healerIndex = generateHealerIndex(wolfIndexes, numPlayers);
    var seekerIndex = generateSeekerIndex(wolfIndexes, healerIndex, numPlayers);

    var playerRoles = assignRolesAndNotifyPlayers(robot, wolfIndexes, healerIndex, seekerIndex);
    setUpWolvesDM(robot, players, wolfIndexes);
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

function setUpWolvesDM(robot, players, wolfIndexes) {
    var ids = [];
    for (var i in wolfIndexes) {
        ids.push(players[wolfIndexes[i]].id);
    }
    createMultiParty(ids, function(multiDM) {
        robot.brain.data.games[gameId].WOLVES_DM = multiDM;
    });

}

function setUpHealerDM(robot, players, healerIndex) {
    var ids = [];
    ids.push(players[healerIndex]);
    createMultiParty(ids, function(multiDM) {
        robot.brain.data.games[gameId].HEALER_DM = multiDM;
    });
}

function setUpSeekerDM(robot, players, seekerIndex) {
    var ids = [];
    ids.push(players[seekerIndex]);
    createMultiParty(ids, function(multiDM) {
        robot.brain.data.games[gameId].SEEKER_DM = multiDM;
    });
}


module.exports = bot;