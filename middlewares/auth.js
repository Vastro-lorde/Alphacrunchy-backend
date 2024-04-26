const JWT = require('jsonwebtoken');
const { roles } = require('../utils/constants');
const secret = process.env.JWT_SECRET;
const bitpowrWebhookSecret = process.env.BITPOWR_WEBHOOK_SECRET;

exports.auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        const decoded = JWT.verify(token, secret, {
            issuer: process.env.JWT_ISSUER,
            audience: process.env.JWT_AUDIENCE,
        });
        if (!decoded) throw new Error("User not found");
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).send({ error: error.message });
    }
}

exports.checkBitPowrHeader = async (req, res, next) => {
    try {
        const token = req.header('x-webhook-secret')?.replace('Bearer ', '');
        if(token !== bitpowrWebhookSecret){
            res.status(401).send('');
        }
        next();
    } catch (error) {
        res.status(401).send({ error: error.message });
    }
}

exports.authRoles =(...Roles)=> {
        return async (req, res, next) => {
        try {
            const userRole = req.user.role;
            const authRoles = [...Roles];
            const result = authRoles.includes(userRole);
            if(!result) return res.status(401).send({ error: 'User not allowed.' });
            next();
        } catch (error) {
            res.status(401).send({ error: error.message });
        }
    }
} 

exports.checkToken = async (req, res, next) => {
    if (req.user.id !== req.params.id && req.user.role !== roles.admin) {
        res.status(401).json({
            status: 'failed',
            message: 'not authorized'
        });
    }
    next();
}