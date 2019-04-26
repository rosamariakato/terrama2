#!/usr/bin/env node

'use strict';

/**
 * It defines which context nodejs should initialize. The context names are available in {@link config/instances}
 * @typeof {string}
 */
var nodeContext = process.argv[2];
console.log('nodeContext ' +nodeContext );

/**
 * It defines which port nodejs should use. When this variables is used, it overrides port number from {@link config/instances}
 */
var nodeContextPort = process.argv[3];
console.log('nodeContextPort ' + nodeContextPort);

/**
 * It defines TerraMA² global configuration (Singleton). Make sure it initializes before everything
 *
 * @type {Application}
 */
var Application = require("./../core/Application");

// setting currentContext
Application.setCurrentContext(nodeContext);

/**
 * Module dependencies.
//  */
const net = require('net');
const Sequelize = require('sequelize');
const pg = require('pg');
const Regex = require('xregexp');
const moment = require('moment');
const CronJob = require('cron').CronJob;
const AdmZip = require('adm-zip');

var PortScanner = require("./../core/PortScanner");
var io = require('../io');
var debug = require('debug')('webapp:server');
var load = require('express-load');
var TcpService = require("./../core/facade/tcp-manager/TcpService");
var TcpManager = require("./../core/TcpManager");
var Utils = require('./../core/Utils');
var Signals = require('./../core/Signals');
var ServiceType = require("./../core/Enums").ServiceType;
var StatusLog = require("./../core/Enums").StatusLog;
var storageUtils = require("./utils");
var sto_core = require("./storage_core");

var app = require('../app');

var portNumber = '3600'; //default port

let version = Application.get().metadata.version;

// storing active connections
var connections = {};
let settings = Application.getContextConfig();

let contextConfig = settings.db;

var debugMessage = "";
let schema = contextConfig.define.schema; // getting terrama2 schema
let databaseName = contextConfig.database; // getting terrama2 database name

const analysisTimestampPropertyName = "execution_date";

if (PortScanner.isValidPort(Number(nodeContextPort))) {
  portNumber = nodeContextPort;
} else {
  debugMessage = "No valid port found. The default port " + portNumber + " will be used";
}

/**
 * Get port from environment and store in Express.
 */
let port = storageUtils.normalizePort(process.env.PORT || portNumber);

/**
 * It defines Storage logger library
 * @type {winston.Logger}
 */
var logger = require("./Logger")(port);

/**
 * Create server.
 */
const server = net.createServer();

if (debugMessage) {
  console.log(debugMessage);
}

/*
* Storages instances array
*/
let Storages = [];

/*
* List with cropjobs with schedule to run storage
*/
let joblist = [];

async function runStorage(clientSocket, client, storage){
  return new Promise(async function resolvePromise(resolve, reject){
    try{
      console.log("Starting ", storage.name, " ", moment().format());
      var buffer =  await TcpManager.makebuffer_be(Signals.START_PROCESS_SIGNAL, {id:storage.id}) ;
    // console.log(buffer);
      clientSocket.write(buffer);

      if (storage.erase_all) //flag has priority 
        storage.keep_data = 0;

      var params = {
        clientSocket: clientSocket, 
        schema: schema, 
        storage: storage,
        client: client,
        logger: logger
      }

      await sto_core.createMessageTable(params);

      //Verifies which data_serie type will be stored
      var select_data_type= "SELECT data_series_semantics.code FROM \
      "+schema+".storages, \
      "+schema+".data_series, \
      "+schema+".data_series_semantics WHERE \
      data_series_semantics.id = data_series.data_series_semantics_id AND \
      data_series.id = \'" + storage.data_series_id + "\'";
      console.log(select_data_type);
      var res1 = await client.query(select_data_type);

      var data_serie_code = res1.rows[0].code;
      storage.data_serie_code = res1.rows[0].code;
      switch (data_serie_code){
        case "GRID-geotiff":
          var res_storage = await sto_core.StoreTIFF(params)
          storage.process.last_process_timestamp = moment();
          storage.process.status = StatusLog.DONE;
          var msg ;
          if (res_storage.flag){
            if (storage.zip){
              msg = storage.name + ": added files: " + res_storage.deleted_files + " from " + res_storage.path + " to " + res_storage.zipfile;
            }
            else if (storage.backup){
              msg = storage.name + ": moved files: " + res_storage.moved_files + " from " + res_storage.path + " to " + res_storage.data_out;
            }
            else{
              msg =storage.name + ": removed files: " + res_storage.deleted_files + " from " + res_storage.path;
            }

            logger.log('info', msg);
            logger.log('info', "Finalized execution of " + storage.name);
            if (res_storage.moved_files === 0 && res_storage.deleted_files === 0){
              storage.process.description = "No data to process"
            }
            else{
              storage.process.data_timestamp = res_storage.data_timestamp;
              storage.process.description = msg;
            }
          }
          else{
            storage.process.description = res_storage.description;
            logger.log('info', "Finalized execution of " + storage.name + " -> " + res_storage.description);
          }

          break;

        case "DCP-single_table":
          await sto_core.StoreSingleTable(params);
 
        break;
        case "DCP-postgis":
        case "ANALYSIS_MONITORED_OBJECT-postgis":
        case "OCCURRENCE-postgis":
          await sto_core.StoreNTable(params);

          logger.log('info', "Finalized execution of " + storage.name);
          storage.process.last_process_timestamp = moment();
          storage.process.status = StatusLog.DONE;
  
          break;
        default:
        console.log("erro -");
        throw("Invalid Data Serie Type!");
      }

      var obj = {
        automatic : storage.automatic_schedule_id ? true : false,
        execution_date : moment().format(),
        instance_id : service_instance_id,
        result : true
      }

      return resolve(obj);
    }
    catch(e){
      console.log(e);
      return reject(e);
    }
  });
};

function updateStorage(newstorage)
{
  return Storages.some(function(storage) {
    if (storage.id === newstorage.id){
      storage = newstorage;
      return storage;
    } 
  });
}

async function addStorage(clientSocket, client, storages_new, projects){
  try{
    for (var storage of storages_new){
 
      var storagefound = Storages.find(s => s.id === storage.id);

      if (storagefound){
        updateStorage(storage);
        logger.debug("Storage Updated: ", storage.name);
        console.log ("Updating ", storage.name)
       }
      else {
        Storages.push(storage);
        if (storage.active){
          logger.debug("Storage Added: ", storage.name);
          console.log ("Adding ", storage.name)
        }
      }
      if (storage.active){
        var res = await client.query("Select * from " + schema + ".projects where id = \'" + storage.project_id + "\'");
        if (res.rowCount){
          if (res.rows[0].active){
            var sql = "Select * from " + schema + ".schedules where id = \'" + storage.schedule_id + "\'";
            console.log(sql);
            var res1 = await client.query(sql);
            if (res1.rowCount){
              var freq = res1.rows[0].frequency;
              var unit = res1.rows[0].frequency_unit;
              var freq_seconds = moment.duration(freq, unit).asSeconds();
              var start = res1.rows[0].frequency_start_time ? new moment(res1.rows[0].frequency_start_time, "HH:mm:ss") : undefined;
              var rule;
              if (res1.rows[0].schedule){
                switch (res1.rows[0].schedule_unit.toLowerCase()){
                  case 'w':
                  case 'wk':
                  case 'week':
                  case 'weeks':
                    rule = "* * * * * " + freq;
                    break;
                }
              }
              else{
                switch (unit.toLowerCase()){
                  case 's':
                  case 'sec':
                  case 'second':
                  case 'seconds':
                    rule = "*/" + freq + " * * * * *";
                    break;
                  case 'min':
                  case 'minute':
                  case 'minutes':
                    rule = "* */" + freq + " * * * *";
                    break;
                  case 'h':
                  case 'hour':
                  case 'hours':
                    rule = "* * */" + freq + " * * *";
                    break;
                  case 'd':
                  case 'day':
                  case 'days':
                    rule = "* * * */" + freq + " * *";
                    break;
                }
              }

              var newjob = new CronJob(rule, async function(){
                //runStorage(clientSocket, client, storage);
                for (var job of joblist) {
                  if (job.job === this){
                    storage = Storages.find(s => s.id === job.id) ;
                    console.log(moment().format(), storage.name, " job ", job.job.cronTime.source, " this ", this.cronTime.source);
                    this.stop();
                    var obj = await runStorage(clientSocket, client, storage);
                    var buffer = await TcpManager.makebuffer_be(Signals.PROCESS_FINISHED_SIGNAL, obj) ;
                      // console.log(buffer.toString());
                    clientSocket.write(buffer);
                    console.log("Finishing", storage.name, " ", moment().format())
                    this.start();
                    break;
                  }
                }
              });

              var update = false;
              for (var job of joblist){
                if (job.id === storage.id){
                  job.job = newjob;
                  update = true;
                  break;
                }
              }

              if (!update)
                joblist.push({
                  id: storage.id,
                  job: newjob
                });
              
              var now = new Date();
              if (start){
                if (now > start){ //It's past time, then fire
                  newjob.start();
                }
                else{ //else wait time
                  var rule = start.seconds() + " " + start.minutes() + " " + start.hours() + " * * *";
                  CronJob(rule, async function(){
                    newjob.start();
                  });
                }
              }
              else //Initial time not defined, then fire
                newjob.start();
            }
          }
        }
      }
    }
  }
  catch(e){
    logger.error(e);
    throw e;
  }
}

let beginOfMessage = "(BOM)\0";
let endOfMessage = "(EOM)\0";

let extraData;
let tempBuffer;
let parsed;
let service_instance_id;
let service_instance_name;
let serviceLoaded_ = false;
let isShuttingDown_ = false;

/**
 * Listen on provided port, on all network interfaces.
 */
server.listen(port, 'localhost', () =>{
  console.log('Storage is running on port ' + port +'.');
});

server.on('error', onError);
server.on('listening', onListening);

let config_db = {
  user: contextConfig.username,
  password: contextConfig.password,
  host: contextConfig.host,
  port: contextConfig.port,
  database: contextConfig.database
};

async function messageTreatment(clientSocket, parsed, client_Terrama2_db){

  switch(parsed.signal){
    case Signals.TERMINATE_SERVICE_SIGNAL:
    console.log("TERMINATE_SERVICE_SIGNAL");
    isShuttingDown_ = true;
    var buffer = await TcpManager.makebuffer_be(Signals.TERMINATE_SERVICE_SIGNAL);
    clientSocket.write(buffer);
    
    process.exit(0);

    break;

  case Signals.STATUS_SIGNAL:
  //console.log("STATUS_SIGNAL");
  if (!serviceLoaded_){
      var buffer = await TcpManager.makebuffer_be(Signals.STATUS_SIGNAL, {service_loaded:false}) ;
    }
    else{
      var obj={
        instance_id : service_instance_id,
        instance_name : service_instance_name,
        logger_online : true,
        service_loaded : true,
        shutting_down : false,
        start_time : moment().format(),
        terrama2_version : version
      }
      var buffer =  await TcpManager.makebuffer_be(Signals.STATUS_SIGNAL, obj) ;
    }
    //console.log(buffer.toString());
    await clientSocket.write(buffer);
    break;

  case Signals.ADD_DATA_SIGNAL:
    console.log("ADD_DATA_SIGNAL");
    if (parsed.message.Storages){
      try{
        await addStorage(clientSocket, client_Terrama2_db, parsed.message.Storages, parsed.message.Projects);
        joblist.forEach(job => {
          console.log("job: ", job.id, job.job.cronTime.source);
        });

        var buffer =  await TcpManager.makebuffer_be(Signals.VALIDATE_PROCESS_SIGNAL, {}) ;
        console.log("Depois do ADD", buffer);
        clientSocket.write(buffer);
      }
      catch(e){
        console.log(e);
      //  var buffer = beginOfMessage + TcpManager.makebuffer_be(Signals.UPDATE_SERVICE_SIGNAL, parsed.message) + endOfMessage;
      //  console.log("ADD_ERROR", buffer);
      //  clientSocket.write(buffer);
      }
    }
  
    break;
  case Signals.START_PROCESS_SIGNAL:
    console.log("START_PROCESS_SIGNAL");
    break;
  case Signals.LOG_SIGNAL:
    console.log("_");
    var begin = parsed.message.begin;
    var end = parsed.message.end;
    var process_ids = parsed.message.process_id; //lista com ids dos processos
    break;

  case Signals.REMOVE_DATA_SIGNAL:
    console.log("REMOVE_DATA_SIGNAL");
    break;
  case Signals.PROCESS_FINISHED_SIGNAL:
    console.log("PROCESS_FINISHED_SIGNAL");
    break;

  case Signals.UPDATE_SERVICE_SIGNAL:
    console.log("UPDATE_SERVICE_SIGNAL");
  //Need to discover how many theads are supported
    if (parsed.message.instance_id){
      serviceLoaded_ = true;
      service_instance_id = parsed.message.instance_id;
      service_instance_name = parsed.message.instance_name;

      config_db.user= parsed.message.log_database.PG_USER;
      config_db.password= parsed.message.log_database.PG_PASSWORD;
      config_db.host= parsed.message.log_database.PG_HOST;
      config_db.port= parsed.message.log_database.PG_PORT;
      config_db.database= parsed.message.log_database.PG_DB_NAME;

      var obj={
        serviceLoaded_ : true,
        instance_id : service_instance_id,
        instance_name : service_instance_name
      }
     // var buffer =  await makebuffer(Signals.UPDATE_SERVICE_SIGNAL, obj) ;
     // console.log("UPDATE_SERVICE_SIGNAL", buffer);
     // await clientSocket.write(buffer);
    }
    else{
      var buffer =  await TcpManager.makebuffer_be(Signals.UPDATE_SERVICE_SIGNAL, parsed.message) ;
      console.log("UPDATE_SERVICE_SIGNAL", buffer);
      clientSocket.write(buffer);
    }
    break;

    case Signals.VALIDATE_PROCESS_SIGNAL:
      console.log("VALIDATE_PROCESS_SIGNAL");
      var buffer =  await TcpManager.makebuffer_be(Signals.VALIDATE_PROCESS_SIGNAL, obj) ;
      console.log("VALIDATE_PROCESS_SIGNAL", buffer);
      clientSocket.write(buffer);
      break;
    }
}

let pool = new pg.Pool(config_db);

// let job0 = new CronJob("*/30 * * * * *", function(){
//   console.log("Crop executando a cada 30 segundos ", moment().format());
// });


pool.connect().then(client_Terrama2_db => {
  server.on('connection', async function(clientSocket) {
    console.log('CONNECTED: ' + clientSocket.remoteAddress + ':' + clientSocket.remotePort);

    // joblist.push({
    //   id: 0,
    //   job: job0
    // });

    // job0.start();
    
    clientSocket.on('data', async function(byteArray) {

      //console.log("RECEIVED: ", byteArray);

      clientSocket.answered = true;

      // append and check if the complete message has arrived
      tempBuffer = storageUtils._createBufferFrom(tempBuffer, byteArray);

      let completeMessage = true;
      // process all messages in the buffer
      // or until we get a incomplete message
      while(tempBuffer && completeMessage) {
        try  {
          let bom = tempBuffer.toString('utf-8', 0, beginOfMessage.length);
          while(tempBuffer.length > beginOfMessage.length && bom !== beginOfMessage) {
            // remove any garbage left in the buffer until a valid message
            // obs: should never happen
            tempBuffer = new Buffer.from(tempBuffer.slice(1));
            bom = tempBuffer.toString('utf-8', 0, beginOfMessage.length);
          }

          if(bom !== beginOfMessage) {
            // no begin of message header:
            //  - clear the buffer
            //  - wait for a new message
            parsed = storageUtils.parseByteArray(byteArray);
            if (parsed.message){
              tempBuffer = undefined;
              completeMessage = false;
            }
            else{
              tempBuffer = undefined;
              throw new Error("Invalid message (BOM)");
            }
          }
          else{
            const messageSizeReceived = tempBuffer.readUInt32BE(beginOfMessage.length);
            const headerSize = beginOfMessage.length + endOfMessage.length;
            const expectedLength = messageSizeReceived + 4;
            if(tempBuffer.length < expectedLength+headerSize) {
              // if we don't have the complete message
              // wait for the rest
              completeMessage = false;
              return;
            }
            var end_pos = tempBuffer.indexOf(endOfMessage);
            const eom1 = tempBuffer.toString('ascii', end_pos, end_pos+endOfMessage.length);
          //  const eom = tempBuffer.toString('ascii', expectedLength + beginOfMessage.length, expectedLength+headerSize);
            if(eom1 !== endOfMessage) {
              // we should have a complete message and and end of message mark
              // if we arrived here we got an ill-formed message
              // clear the buffer and raise an error
              tempBuffer = undefined;
              throw new Error("Invalid message (EOM)");
            }

            // if we got many messages at once
            // hold the buffer we the extra messages for processing
            if(tempBuffer.length > expectedLength+headerSize) {
              extraData = new Buffer.from(tempBuffer.slice(expectedLength + headerSize));
            } else {
              extraData = undefined;
            }

            // get only the first message for processing
            tempBuffer = new Buffer.from(tempBuffer.slice(beginOfMessage.length, expectedLength+beginOfMessage.length));
            parsed = storageUtils.parseByteArray(tempBuffer);
            // get next message in the buffer for processing
            tempBuffer = extraData;
          }
          
        //  console.log("Size: " + parsed.size + " Signal: " + parsed.signal + " Message: " + JSON.stringify(parsed.message, null, 4));
      
          await messageTreatment(clientSocket, parsed, client_Terrama2_db);
        }
        catch(e){
          console.log(e);
          throw (e);
        }
      }
    });
    clientSocket.on('error', function(err) {
      console.log(err);
    });
  });
});

// detecting sigint error and then close server
process.on('SIGINT', async () => {
  TcpService.finalize();
  TcpService.disconnect();

   server.close(() => {
     console.log('Storage finalized');

     process.exit(0);
   });

  for (var key in connections)
    connections[key].destroy();
});

process.on('message', async (msg) =>{
  console.log(msg);
})


/**
 * Event listener for HTTP server "error" event.
 */
function onError(error) {
  if (error.syscall !== 'listen') {
      console.log(error);
  }

  var bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.log(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.log(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      console.log(error);
  }
}

function handle(signal){
  console.log('Received ${signal}');
}

/**
 * Event listener for HTTP server "listening" event.
 */
function onListening() {
  var addr = server.address();
  var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;

  console.log('Listening on ' + bind);
}

io.attach(server);
load('sockets').into(io);
