const bcrypt = require('bcrypt');
const User = require('../models/userModel.js');
const Wallet = require('../models/walletModel.js');
const { signUpMailer, resetPasswordMailer, noticeMailer, otpMailer } = require('../utils/nodeMailer.js');
const { serverError, createOtp, formatEmail } = require('../utils/services.js');
const { operations } = require('../utils/constants.js');
const jwt = require('jsonwebtoken');
const { sendSmsOtp } = require('../utils/smsService.js');

// controller for signing up
exports.registration = async (req, res) => {
    try {
        let checkUser = await User.findOne({ email: req.body.email});
        if (checkUser !== null) {
            return res.status(401).json({
                status: 'failed',
                message: 'email already exists'
            });
        }
        else {
            const { fullName, email, phoneNumber, password, country } = req.body;
            const otp = createOtp();
            const hashedOtp = await bcrypt.hash(otp.toString(), 10);
            var user = await User.create({
                fullName,
                email,
                phoneNumber,
                otp: hashedOtp,
                password
            });
            signUpMailer(fullName, email, otp);
            user.password = "";
            user.otp = "";
                return res.status(201).json({
                    data: user,
                    success: true,
                    message: `Successfully created user: ${fullName}, an email has been sent to ${email}` 
                });
        }

        
    } catch (error) {
        await User.findByIdAndDelete({_id: user._id},{ useFindAndModify: false});
        return serverError(res, error);
    }
}

// signin in controller where token is created.
exports.loggingIn = async (request, response) => {
    const {email, password} = request.body;
    try {
        const user = await User.findOne({ email: email });
        const checkWallets = await Wallet.find({user_id: user._id}).select("-wallet_pin");
        if (user) {
            const isPasswordMatching = await bcrypt.compare(password, user.password);
            
            if (!user.confirmedEmail) {
                return response.status(400).json({
                    success: false,
                    message: "email not yet confirmed, please check your email or create new otp"
                  });
            }
            // if 2 factor auth is enable we generate the otp here for and send an sms
            if (isPasswordMatching) {
                if (user.twoFactorAuth?.enabled) {
                    const otp =  createOtp();
                    const hashedOtp = await bcrypt.hash(otp.toString(), 10);

                    user.twoFactorAuth.secret = hashedOtp
                    user.twoFactorAuth.expiresAt = new Date( Date.now() + 2 * 60 * 1000)

                    const otpPhone = `${user.phoneNumber.slice(0,7)}...${user.phoneNumber.slice(-2)}` // making the phonenumber to this format 0801...89
                    const otpEmail = formatEmail(user.email)
                    await User.findByIdAndUpdate({_id: user._id},{ twoFactorAuth: user.twoFactorAuth }).catch((error)=>{
                        console.log(error);
                    })
                    await Promise.all([
                        otpMailer(user.email, otp), 
                        // sendSmsOtp(user.phoneNumber, otp)
                    ])
                    .then(() => {
                        return response.status(200).json({
                            is2FactorEnabled: true,
                            data: user,
                            success: true,
                            message: `An OTP has been sent to: ${otpPhone} and ${otpEmail}`,
                            expiresIn: user.twoFactorAuth.expiresAt,
                        });
                    })
                    .catch((error) => {
                        console.log(error);
                        return serverError(response, error);
                    });

                    
                } else {
                    const secret = process.env.JWT_SECRET;

                    const dataStoredInToken = {
                        id: user._id.toString(),
                        email: user.email,
                        fullName: user.fullName,
                        role: user.role
                    };

                    //signing token
                    const token = jwt.sign(dataStoredInToken,secret,{
                    expiresIn:"7d",
                    audience: process.env.JWT_AUDIENCE,
                    issuer: process.env.JWT_ISSUER
                    });
                    user.password = "";
                    const today = new Date();

                    return response.status(200).json({
                        data: user,
                        wallets: checkWallets,
                        success: true,
                        is2FactorEnabled: false,
                        message: `Login Successfull`,
                        token: token,
                        expiresIn: new Date(today.getTime() + (6 * 24 * 60 * 60 * 1000))
                    });
                }
            } else {
                return response.status(401).json({
                    success: false,
                    message: "Username or Password incorrect"
                  });
            }
          } else {
            return response.status(404).json({
                success: false,
                message: "User not found"
              });
          }
    } catch (error) {
        return serverError(response, error);
    }
}

// 2 factor signin in controller where token is created.
exports.twoFactorLoggingIn = async (request, response) => {
    const {email, otp} = request.body;
    try {
        const user = await User.findOne({ email: email });
        const checkWallets = await Wallet.find({user_id: user._id}).select("-wallet_pin");
        if (user) {
            const isOtpMatching = await bcrypt.compare(otp, user.twoFactorAuth?.secret);
            if (user.twoFactorAuth.expiresAt < Date.now()) {
                return res.status(400).json({
                    success: false,
                    message: 'otp expired'
                });
            }
            if (!user.confirmedEmail) {
                return response.status(400).json({
                    success: false,
                    message: "email not yet confirmed, please check your email or create new otp"
                  });
            }
            if (!user.twoFactorAuth?.enabled) {
                return response.status(400).json({
                    success: false,
                    message: "Two Factor Authentication not enabled"
                  });
            }
            if (isOtpMatching) {

                const secret = process.env.JWT_SECRET;

                const dataStoredInToken = {
                    id: user._id.toString(),
                    email: user.email,
                    fullName: user.fullName,
                    role: user.role
                  };

                //creating token
                const token = jwt.sign(dataStoredInToken,secret,{
                  expiresIn:"7d",
                  audience: process.env.JWT_AUDIENCE,
                  issuer: process.env.JWT_ISSUER
                });
                user.password = "";
                const today = new Date();

                //resetting the 2 factor properties to default value
                const updatedUser =  await User.findOneAndUpdate(
                    { _id: user._id }, // Specify the query condition to find the user
                    { 
                      $unset: { 'twoFactorAuth.expiresAt': 1 }, // Unset the tempSecretExpiresAt field
                      $set: { 'twoFactorAuth.secret': '' } // Set the secret field to an empty string
                    },
                    { 
                      new: true, // Return the updated document
                      setDefaultsOnInsert: true // Apply default values on insert
                    }
                ).select('-password')

                return response.status(200).json({
                    data: updatedUser,
                    wallets: checkWallets,
                    success: true,
                    message: `Login Successfull`,
                    token: token,
                    expiresIn: new Date(today.getTime() + (6 * 24 * 60 * 60 * 1000))
                });
            } else {
                return response.status(401).json({
                    success: false,
                    message: "Wrong OTP"
                  });
            }
          } else {
            return response.status(404).json({
                success: false,
                message: "User not found"
              });
          }
    } catch (error) {
        return serverError(response, error);
    }
}

// controller to confirm a User's email
exports.confirmUserEmail = async (req, res) => {
    const {otp, id} = req.body;
    try {
        
        const checkUser = await User.findOne({ _id: id}).lean();
        if (!checkUser) {
            return res.status(204).json({
                status: 'failed',
                message: 'user not found'
            });
        }
        if (checkUser.otp ===''){
            return res.status(400).json({
                status: 'failed',
                message: 'email already confirmed'
            });

        }
        const isMatching = await bcrypt.compare(otp, checkUser.otp);
        if (isMatching) {
            await User.findByIdAndUpdate({_id: id},{confirmedEmail : true, otp: ''});
            return res.status(200).json({
                status: 'success'
            });
        }
        else{
            return res.status(400).json({
                status: 'failed',
                message: 'otp not matched'
            });
        }
        
    } catch (error) {
        return serverError(res, error);
    }
}

// controller for reseting a User's password
exports.resetPassword = async (req, res) => {
    const {otp, id, password} = req.body;
    try {
        
        const checkUser = await User.findOne({ _id: id}).lean();
        if (!checkUser) {
            return res.status(404).json({
                status: 'failed',
                message: 'user not found'
            });
        }
        const isMatching = await bcrypt.compare(otp, checkUser.otp);
        if (isMatching) {
            const hashedPassword = await bcrypt.hash(password, 10);
            await User.findByIdAndUpdate({_id: id},{ password: hashedPassword, otp: ''});
            noticeMailer(checkUser.email, operations.changedPassword);
            return res.status(200).json({
                status: 'success',
                message: 'Password changed successfully.'
            });
        }
        else {
            return res.status(400).json({
                status: 'failed',
                message: 'otp not matched'
            });
        }
    } catch (error) {
        return serverError(res, error);
    }
}

// controller for reseting a User's wallet pin
exports.resetPin = async (req, res) => {
    const {otp, wallet_number, pin} = req.body;

    if (parseInt(pin)< 1000 || parseInt(pin) > 9999) {
        return res.status(404).json({
            success: false,
            message: 'invalid pin'
        });
    }
    if (!wallet_number) {
        return res.status(404).json({
            success: false,
            message: 'invalid wallet number '+ wallet_number
        });
    }
    try {
        const checkWallet = await Wallet.findOne({wallet_number}).lean();
        const checkUser = await User.findOne({ _id: checkWallet.user_id}).lean();
        if (!checkUser) {
            return res.status(404).json({
                success: false,
                message: 'user not found'
            });
        }
        if (!checkWallet) {
            return res.status(404).json({
                success: false,
                message: 'wallet not found'
            });
        }
        const isMatching = await bcrypt.compare(otp, checkUser.twoFactorAuth?.secret);
        if (isMatching) {
            if (checkUser.twoFactorAuth.expiresAt < Date.now()) {
                return res.status(400).json({
                    success: false,
                    message: 'otp expired'
                });
            }
            const hashedPin = await bcrypt.hash(pin, 10);
            const wallet = await Wallet.findOneAndUpdate({wallet_number},{ wallet_pin: hashedPin});
            await User.findByIdAndUpdate({_id: checkWallet.user_id}, {otp: ""})
            noticeMailer(checkUser.email, operations.changedWalletPin);
            return res.status(200).json({
                data: wallet,
                success: true,
                message: 'Wallet Pin changed successfully.'
            });
        }
        else {
            return res.status(400).json({
                success: false,
                message: 'otp not matched'
            });
        }
    } catch (error) {
        return serverError(res, error);
    }
}

// controller for reseting a User's wallet pin
exports.changeWalletPin = async (req, res) => {
    const {wallet_number, current_pin, pin} = req.body;

    if (parseInt(pin)< 1000 || parseInt(pin) > 9999) {
        return res.status(404).json({
            success: false,
            message: 'invalid new pin'
        });
    }
    try {
        const checkWallet = await Wallet.findOne({wallet_number}).lean();
        const checkUser = await User.findOne({ _id: checkWallet.user_id}).lean();
        if (!checkUser) {
            return res.status(404).json({
                success: false,
                message: 'user not found'
            });
        }
        if (!checkWallet) {
            return res.status(404).json({
                success: false,
                message: 'wallet not found'
            });
        }
        const isMatching = await bcrypt.compare(current_pin, checkWallet.wallet_pin);
        if (isMatching) {
            const hashedPin = await bcrypt.hash(pin, 10);
            const wallet = await Wallet.findOneAndUpdate({wallet_number},{ wallet_pin: hashedPin }, { new: true });
            noticeMailer(checkUser.email, operations.changedWalletPin);
            return res.status(200).json({
                data: wallet,
                success: true,
                message: 'Wallet Pin changed successfully.'
            });
        }
        else {
            return res.status(400).json({
                success: false,
                message: 'old pin incorrect'
            });
        }
    } catch (error) {
        return serverError(res, error);
    }
}

// controller for requesting reset of a User's password.
exports.requstResetPassword = async (req, res) => {
    const {email} = req.body;
    try {
        var checkUser = await User.findOne({ email: email}).lean();
        if (!checkUser) {
            return res.status(404).json({
                status: 'failed',
                message: 'user not found'
            });
        }
        const otp =  createOtp();
        const hashedOtp = await bcrypt.hash(otp.toString(), 10);
        await User.findByIdAndUpdate({_id: checkUser._id},{ otp: hashedOtp });
        resetPasswordMailer(checkUser.email, otp);
            return res.status(200).json({
                status: 'success',
                message: 'an email has been sent with the reset otp'
            });
        
    } catch (error) {
        return serverError(res, error);
    }
}

//uses either email or phone number
exports.requestOtp = async (req, res) => {
    const {email, phoneNumber} = req.body;
    try {
        
        const otp =  createOtp();
        const hashedOtp = await bcrypt.hash(otp.toString(), 10);
        var checkUser = await User.findOne(email? { email} : { phoneNumber }).lean();
        if (!checkUser) {
            return res.status(404).json({
                status: 'failed',
                message: 'user not found'
            });
        }
        
        checkUser.twoFactorAuth.secret = hashedOtp
        checkUser.twoFactorAuth.expiresAt = new Date( Date.now() + 2 * 60 * 1000) // expires in 10mins time

        await User.findByIdAndUpdate({_id: checkUser._id},{ twoFactorAuth: checkUser.twoFactorAuth })
        try {
            otpMailer(checkUser.email, otp)
            // if (email) {
            //     otpMailer(checkUser.email, otp)
            // }
            // sendSmsOtp(checkUser.phoneNumber, otp)
        } catch (error) {
            return res.status(500).json({
                status: 'failed',
                message: 'an error has occured we are working on it',
                error: error
            });
        }
        const minutes = Math.floor((checkUser.twoFactorAuth.expiresAt.getTime() - Date.now()) / 60000);
        return res.status(200).json({
            status: 'success',
            message: `otp sent and expires in ${minutes} minutes`,
            expiresIn: checkUser.twoFactorAuth.expiresAt
        });
        
    } catch (error) {
        return serverError(res, error);
    }
}

exports.setup2Factor = async (req, res) => {
    const {email, phoneNumber, otp, state} = req.body;
    try {
        var checkUser = await User.findOne(email? { email} : { phoneNumber }).lean();
        const isOtpMatching = await bcrypt.compare(otp, checkUser.twoFactorAuth?.secret);
        if (!checkUser) {
            return res.status(404).json({
                success: false,
                message: 'user not found'
            });
        }

        if (isOtpMatching) {
            const twoFA = {
                enabled : state,
                secret : ''
            }
    
            if (checkUser.twoFactorAuth.expiresAt < Date.now()) {
                return res.status(400).json({
                    success: false,
                    message: 'otp expired'
                });
            }
            const setUser = await User.findByIdAndUpdate({_id: checkUser._id},{ twoFactorAuth: {...twoFA} }, { new: true}).select('-password');
            return res.status(200).json({
                data: setUser,
                success: true,
                message: `2 factor authentication ${setUser.twoFactorAuth.enabled? 'activated': 'deactivated'}`
            });
        } else {
            return res.status(401).json({
                success: false,
                message: 'otp not matching'
            });
        }
        
    } catch (error) {
        return serverError(res, error);
    }
}

// change user password (must provide auth token data).
exports.changePassword = async (request, response) => {
    const {currentPassword, password} = request.body;
    try {
        const user = await User.findById(request.user.id);
        if (user) {
            const isPasswordMatching = await bcrypt.compare(currentPassword, user.password);
            if (isPasswordMatching) {
                // hash password
                const hashedPassword = await bcrypt.hash(password, 10);
                const result = await User.findByIdAndUpdate(request.user.id,{password: hashedPassword}, {new: true}).select("-password");
                return response.status(200).json({
                    data: result,
                    success: true,
                    message: `Changed Password Successfully`
                });
            } else {
                return response.status(401).json({
                    success: false,
                    message: "Old Password incorrect"
                });
            }
          } else {
            return response.status(404).json({
                success: false,
                message: "User not found"
              });
          }
    } catch (error) {
        return serverError(response, error);
    }
}