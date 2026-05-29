# encoding: utf-8
require 'webrick'
dir = File.expand_path('..', __FILE__)
server = WEBrick::HTTPServer.new(Port: 3456, DocumentRoot: dir, Logger: WEBrick::Log.new('/dev/null'), AccessLog: [])
trap('INT') { server.shutdown }
server.start
