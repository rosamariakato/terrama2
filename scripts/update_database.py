import json
import psycopg2
import glob
import os
import sys
import re

# open version file
with open("../version.json") as version_file:
    version = json.load(version_file)
    major = version["major"]
    minor = version["minor"]
    patch = version["patch"]
    tag = version["tag"]
    database = version["database"]

    print("Installing version: "+str(major)+"."+str(minor)+"."+str(patch)+"-"+tag)
    print("Database version: "+str(database))

# error reading version file
if major is None:
    sys.exit(1)

config = '../webapp/config/webapp.json'
if os.path.isfile(config):
    # read all configured instances and update all databases
    with open(config) as data_file:
        data = json.load(data_file)

        for key in data:
            # get database config for this terrama2 instance
            database_uri = data[key]["db"]["database"]
            username = data[key]["db"]["username"]
            password = data[key]["db"]["password"]
            host = data[key]["db"]["host"]

            print("Current database: "+database_uri)

            try:
                conn = psycopg2.connect(host=host, database=database_uri, user=username, password=password)
            except psycopg2.OperationalError:
                continue

            cursor = conn.cursor()
            conn.autocommit = True
            try:
                # get current version from database
                cursor.execute("SELECT major, minor, patch, tag, database FROM terrama2.version ORDER BY insert_time DESC LIMIT 1")
                record = cursor.fetchone()
                current_major = record[0]
                current_minor = record[1]
                current_patch = record[2]
                current_tag = record[3]
                current_database = record[4]
            except psycopg2.ProgrammingError:
                # no database found, assume 4.0-0
                current_major = 4
                current_minor = 0
                current_patch = 0
                current_tag = 'release'
                current_database = 0

            print("Current version: "+str(current_major)+"."+str(current_minor)+"."+str(current_patch)+"-"+current_tag)
            print("Database version: "+str(current_database))

            if not current_major:
                # should never be here
                sys.exit(1)

            while current_major != major or current_minor != minor or current_database != database:
                # grab convertion scripts for current database version
                converters = glob.glob("../scripts/bd_update/"+str(current_major)+"."+str(current_minor)+"-"+str(current_database)+"_*.sql")
                if converters is None:
                    sys.exit(1)

                update_script = converters[0]
                # update database to next version
                cursor.execute(open(update_script, "r").read())

                # extract new version of the database
                match = re.search(str(current_major)+"\."+str(current_minor)+"-"+str(current_database)+"_(\d+)\.(\d+)-(\d+)\.sql", update_script)
                current_major = int(match.group(1))
                current_minor = int(match.group(2))
                current_database = int(match.group(3))
            pass
