"use strict";

tutao.provide('tutao.tutanota.ctrl.AdminNewUser');

/**
 * A new user that should be added to an existing customer
 * @constructor
 */
tutao.tutanota.ctrl.AdminNewUser = function(availableDomains){
    this.mailAddressPrefix = ko.observable("");
    this.mailAddressStatus = ko.observable({ type: "neutral", text: "mailAddressNeutral_msg"});

    this.name = ko.observable("");
    this.password = ko.observable(tutao.tutanota.util.PasswordUtils.generatePassword(10));
    this.state = ko.observable(tutao.tutanota.ctrl.AdminNewUser.STATE_NONE);
    this.domain = ko.observable("");
    this.availableDomains = availableDomains;

    this.mailAddress = ko.computed(function(){
        return tutao.tutanota.util.Formatter.getCleanedMailAddress(this.mailAddressPrefix() + "@" + this.domain());
    }, this);

    this.mailAddress.subscribe(this._verifyMailAddress, this);
};

tutao.tutanota.ctrl.AdminNewUser.prototype._verifyMailAddress = function(cleanedValue) {
    var self = this;
    if ( self.mailAddressPrefix().length < 1){
        this.mailAddressStatus({ type: "neutral", text: "mailAddressNeutral_msg"});
        return;
    }
    if (tutao.entity.tutanota.TutanotaConstants.TUTANOTA_MAIL_ADDRESS_DOMAINS.indexOf(self.domain()) != -1
        && self.mailAddressPrefix().trim().length < tutao.tutanota.ctrl.RegistrationViewModel.MINIMUM_MAIL_ADDRESS_PREFIX_LENGTH) {
            self.mailAddressStatus({ type: "invalid", text: "mailAddressInvalid_msg"});
        return
    }
    if (!tutao.tutanota.util.Formatter.isMailAddress(cleanedValue, true)) {
        self.mailAddressStatus({ type: "invalid", text: "mailAddressInvalid_msg"});
        return;
    }
    self.mailAddressStatus({ type: "invalid", text: "mailAddressBusy_msg"});

    setTimeout(function() {
        if (self.mailAddress() == cleanedValue) {
            tutao.entity.sys.DomainMailAddressAvailabilityReturn.load(new tutao.entity.sys.DomainMailAddressAvailabilityData().setMailAddress(cleanedValue), [], tutao.entity.EntityHelper.createAuthHeaders()).then(function(domainMailAddressAvailabilityReturn) {
                if (self.mailAddress() == cleanedValue) {
                    if (domainMailAddressAvailabilityReturn.getAvailable()) {
                        self.mailAddressStatus({ type: "valid", text: "mailAddressAvailable_msg"});
                    } else {
                        self.mailAddressStatus({ type: "invalid", text: "mailAddressNA_msg"});
                    }
                }
            });
        }
    }, 500);
};

/**
 * Provides the status of the password.
 * @return {Object} The status containing type and text id.
 */
tutao.tutanota.ctrl.AdminNewUser.prototype.getPasswordStatus = function () {
    if (this.password() == "") {
        return { type: "neutral", text: "password1Neutral_msg" };
    } else if (this.getPasswordStrength() >= 80) {
        return { type: "valid", text: "passwordValid_msg" };
    } else if (this.password().trim().length < 1) {
        return { type: "invalid", text: "password1InvalidTooShort_msg" };
    } else {
        return { type: "neutral", text: "password1InvalidUnsecure_msg" };
    }
};

tutao.tutanota.ctrl.AdminNewUser.prototype.getPasswordStrength = function () {
    return tutao.tutanota.util.PasswordUtils.getPasswordStrength(this.password(), [])
};

tutao.tutanota.ctrl.AdminNewUser.STATE_NONE = "";
tutao.tutanota.ctrl.AdminNewUser.STATE_IN_PROGRESS = "progress";
tutao.tutanota.ctrl.AdminNewUser.STATE_SUCCESS = "success";
tutao.tutanota.ctrl.AdminNewUser.STATE_FAILED = "failed";

tutao.tutanota.ctrl.AdminNewUser.prototype.isCreateAccountPossible = function() {
    return this.mailAddressStatus().type == "valid" &&
        this.getPasswordStatus().type != "invalid";
};

/**
 * Create the new user
 * @return {Promise.<>} Resolved when finished, rejected if the rest call failed.
 */
tutao.tutanota.ctrl.AdminNewUser.prototype.create = function () {
    var self = this;
    this.state(tutao.tutanota.ctrl.AdminNewUser.STATE_IN_PROGRESS);
    var adminUser = tutao.locator.userController.getLoggedInUser();
    var memberships = adminUser.getMemberships();
    var adminUserKey = tutao.locator.userController.getUserGroupKey();

    return adminUser.loadCustomer().then(function (customer) {
        // get the admin group and customer group keys via the group memberships of the admin user
        var adminGroupKey = null;
        var customerGroupKey = null;
        for (var i = 0; i < memberships.length; i++) {
            if (memberships[i].getAdmin()) {
                adminGroupKey = tutao.locator.aesCrypter.decryptKey(adminUserKey, memberships[i].getSymEncGKey());
            } else if (memberships[i].getGroup() === customer.getCustomerGroup()) {
                customerGroupKey = tutao.locator.aesCrypter.decryptKey(adminUserKey, memberships[i].getSymEncGKey());
            }
        }
        if (!adminGroupKey) {
            return Promise.reject(new Error("could not create customer, the adminGroupKey is null!"));
        }
        if (!customerGroupKey) {
            return Promise.reject(new Error("could not create customer, the customerGroupKey is null!"));
        }

        var salt = tutao.locator.kdfCrypter.generateRandomSalt();
        return tutao.locator.kdfCrypter.generateKeyFromPassphrase(self.password(), salt, tutao.entity.tutanota.TutanotaConstants.KEY_LENGTH_TYPE_128_BIT).then(function (userPassphraseKey) {

            var userGroupsListKey = tutao.locator.aesCrypter.generateRandomKey(); // legacy, not used any more
            return tutao.tutanota.ctrl.GroupData.generateGroupKeys(self.name(), self.mailAddress(), userPassphraseKey, adminGroupKey, customerGroupKey, userGroupsListKey).spread(function (userGroupData, userGroupKey) {
                /** @type tutao.entity.sys.UserData */
                var userService = new tutao.entity.sys.UserData()
                    .setUserEncClientKey(tutao.locator.aesCrypter.encryptKey(userGroupKey, tutao.locator.aesCrypter.generateRandomKey()))
                    .setUserEncCustomerGroupKey(tutao.locator.aesCrypter.encryptKey(userGroupKey, customerGroupKey))
                    .setUserGroupData(userGroupData)
                    .setSalt(tutao.util.EncodingConverter.uint8ArrayToBase64(salt))
                    .setVerifier(tutao.crypto.Utils.createAuthVerifier(userPassphraseKey))
                    .setMobilePhoneNumber("")
                    .setDate(tutao.entity.tutanota.TutanotaConstants.CURRENT_DATE);

                return userService.setup({}, null).then(function(userReturn, exception) {
                    return tutao.tutanota.ctrl.AdminNewUser.initGroup(userReturn.getUserGroup(), userGroupKey);
                });
            });
        });
    }).then(function() {
        self.state(tutao.tutanota.ctrl.AdminNewUser.STATE_SUCCESS);
    }).caught(function(e) {
        self.state(tutao.tutanota.ctrl.AdminNewUser.STATE_FAILED);
        throw e;
    });
};

/**
 * Initializes the given user group for Tutanota (creates mail box etc.). The admin must be logged in.
 * @param {string} groupId The group to initialize.
 * @param {Object} groupKey the group key.
 * @return {Promise.<>} Resolved when finished, rejected if the rest call failed.
 */
tutao.tutanota.ctrl.AdminNewUser.initGroup = function(groupId, groupKey) {
	var s = new tutao.entity.tutanota.InitGroupData();
	
	s.setGroupId(groupId);
    s.setGroupEncEntropy(tutao.locator.aesCrypter.encryptBytes(groupKey, tutao.util.EncodingConverter.uint8ArrayToBase64(tutao.locator.randomizer.generateRandomData(32))));

	var mailBoxSessionkey = tutao.locator.aesCrypter.generateRandomKey();
	s.setSymEncMailBoxSessionKey(tutao.locator.aesCrypter.encryptKey(groupKey, mailBoxSessionkey));

	var contactListSessionkey = tutao.locator.aesCrypter.generateRandomKey();
	s.setSymEncContactListSessionKey(tutao.locator.aesCrypter.encryptKey(groupKey, contactListSessionkey));

	var fileSystemSessionkey = tutao.locator.aesCrypter.generateRandomKey();
	s.setSymEncFileSystemSessionKey(tutao.locator.aesCrypter.encryptKey(groupKey, fileSystemSessionkey));

    var externalGroupInfoListKey = tutao.locator.aesCrypter.generateRandomKey();
    s.setSymEncExternalGroupInfoListKey(tutao.locator.aesCrypter.encryptKey(groupKey, externalGroupInfoListKey));

	return s.setup({}, tutao.entity.EntityHelper.createAuthHeaders());
};
